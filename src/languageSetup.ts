import * as child_process from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, RevealOutputChannelOn, ServerOptions, StreamInfo } from "vscode-languageclient/node";
import { LOG } from './util/logger';
import { isOSUnixoid, correctScriptName } from './util/osUtils';
import { ServerDownloader } from './serverDownloader';
import { JarClassContentProvider } from "./jarClassContentProvider";
import { KotlinApi } from "./lspExtensions";
import { fsExists } from "./util/fsUtils";
import { ServerSetupParams } from "./setupParams";
import { RunDebugCodeLens } from "./runDebugCodeLens";
import { MainClassRequest, OverrideMemberRequest } from "./lspExtensions";

type TServerDebugConfig = {
    is_enabled: boolean,
    auto_suspend: boolean,
    port: number,
}

enum TransportLayer {
    STDIO = "stdio",
    TCP = "tcp",
    TCP_RANDOM = "tcp-random",
    TCP_ATTACH = "tcp-attach"
}

// handle tcp
// - handle tcp launch
// - handle tcp attach
// handle stdio


/** Downloads and starts the language server. */
export async function activateLanguageServer({ context, status, config, javaInstallation, javaOpts }: ServerSetupParams): Promise<KotlinApi> {
    LOG.info('Activating Kotlin Language Server...');
    status.update("Activating Kotlin Language Server...");
    
    // Prepare language server
    const langServerInstallDir = path.join(context.globalStorageUri.fsPath, "langServerInstall");
    const customPath: string = config.get("languageServer.path");
    
    if (!customPath) {
        const langServerDownloader = new ServerDownloader("Kotlin Language Server", "kotlin-language-server", "server.zip", "server", langServerInstallDir);
        
        try {
            await langServerDownloader.downloadServerIfNeeded(status);
        } catch (error) {
            console.error(error);
            vscode.window.showWarningMessage(`Could not update/download Kotlin Language Server: ${error}`);
            return;
        }
    }

    const outputChannel = vscode.window.createOutputChannel("Kotlin");
    context.subscriptions.push(outputChannel);

    status.dispose();
    
    const startScriptPath = customPath || path.resolve(langServerInstallDir, "server", "bin", correctScriptName("kotlin-language-server"));

    const storagePath = context.storageUri.fsPath
    if (!(await fsExists(storagePath))) {
        await fs.promises.mkdir(storagePath);
    }

    const customFileEventsGlobPatterns: string[] = config.get("languageServer.watchFiles")
    const fileEventsGlobPatterns = customFileEventsGlobPatterns || [
        "**/*.kt",
        "**/*.kts",
        "**/*.java",
        "**/pom.xml",
        "**/build.gradle",
        "**/settings.gradle"
    ];

    // do not move into dedicated function
    // or it would break abstractions
    let transportLayer: TransportLayer = config.get("languageServer.transport");
    const serverOptions: ServerOptions = (() => {
        if (TransportLayer[transportLayer] == undefined) {

            const DEFAULT_TRANSPORT_LAYER = TransportLayer.STDIO;
            LOG.info(`Unknown transport layer: ${transportLayer}. Falling back to default: ${DEFAULT_TRANSPORT_LAYER}`);

            config.update("languageServer.transport", DEFAULT_TRANSPORT_LAYER);
            transportLayer = DEFAULT_TRANSPORT_LAYER
        }

        if (transportLayer != TransportLayer.TCP_ATTACH && isOSUnixoid()) {
            // Ensure that start script can be executed
            const current_mode = fs.statSync(startScriptPath).mode & 0o777
            fs.chmodSync(startScriptPath, current_mode | fs.constants.S_IXUSR)
        }

        if (transportLayer == TransportLayer.STDIO) {
            LOG.info("Connecting via Stdio.");

            const debugConfig: TServerDebugConfig = {
                is_enabled: config.get("languageServer.debugAttach.enabled"),
                auto_suspend: config.get("languageServer.debugAttach.autoSuspend"),
                port: config.get("languageServer.debugAttach.port")
            };

            const env: any = { ...process.env };

            if (javaInstallation.javaHome) {
                env['JAVA_HOME'] = javaInstallation.javaHome;
            }
        
            if (javaOpts) {
                env['JAVA_OPTS'] = javaOpts;
            }

            return stdio_launch(startScriptPath, env, debugConfig);
        }
        
        const tcpPort: number = config.get("languageServer.port");
        if (transportLayer == TransportLayer.TCP) {
            // TCP STARTING PROCEDURE
            // Create TCP Server on vscode's side
            // start server and await it to connect
            // create language client on vscode's side and 
            // delegate connection with server to it

            LOG.info(`Connecting via TCP, port: ${tcpPort}`);
            return () => tcp_launch(outputChannel, startScriptPath,tcpPort)
        }

        if (transportLayer == TransportLayer.TCP_RANDOM) {
            return () => tcp_launch(outputChannel, startScriptPath, null);
        }

        if (transportLayer == TransportLayer.TCP_ATTACH) {
            // when attaching, we no longer control the lifecycle of a server
            // Thus we listen when connection is terminated 
            // to spawn a new language-client and wait for new server connection.
            // We can't reuse existing 
            tcp_attach(outputChannel, tcpPort)
        }
    })()

    const languageClient = createLanguageClient(outputChannel, serverOptions, storagePath, fileEventsGlobPatterns);

    // Create the language client and start the client.
    let languageClientPromise = languageClient.start();
    
    // Register a content provider for the 'kls' scheme
    const contentProvider = new JarClassContentProvider(languageClient);
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("kls", contentProvider));

    // register override members command
    vscode.commands.registerCommand("kotlin.overrideMember", async() => {
        const activeEditor = vscode.window.activeTextEditor;
        const currentDocument = activeEditor?.document;
        // TODO: seems like we cant interact with the inner edit-fields as if it were a WorkspaceEdit object?? See if there is a way to solve this
        const overrideOptions = await languageClient.sendRequest(OverrideMemberRequest.type, {
            textDocument: {
                uri: currentDocument.uri.toString()
            },
            position: activeEditor?.selection.start
        });

        // show an error message if nothing is found
        if(0 == overrideOptions.length) {
            vscode.window.showWarningMessage("No overrides found for class");
            return;
        }
        
        const selected = await vscode.window.showQuickPick(overrideOptions.map(elem => ({
            label: elem.title,
            data: elem.edit.changes[currentDocument.uri.toString()]
        })), {
            canPickMany: true,
            placeHolder: 'Select overrides'
        });

        // TODO: find out why we can't use vscode.workspace.applyEdit directly with the results. Probably related to the issue mentioned above
        // we know all the edits are in the current document, and that each one only contain one edit, so this hack works
        activeEditor.edit(editBuilder => {
            selected.forEach(elem => {
                const textEdit = elem.data[0];
                editBuilder.insert(textEdit.range.start, textEdit.newText);
            });
        });
    });

    // Activating run/debug code lens if the debug adapter is enabled
    // and we are using 'kotlin-language-server' (other language servers
    // might not support the non-standard 'kotlin/mainClass' request)
    const debugAdapterEnabled = config.get("debugAdapter.enabled");
    const usesStandardLanguageServer = startScriptPath.endsWith("kotlin-language-server");
    if (debugAdapterEnabled && usesStandardLanguageServer) {
        vscode.languages.registerCodeLensProvider("kotlin", new RunDebugCodeLens())
    
        vscode.commands.registerCommand("kotlin.resolveMain", async(fileUri) => {
            return await languageClient.sendRequest(MainClassRequest.type, {
                uri: fileUri
            })
        });
    
        vscode.commands.registerCommand("kotlin.runMain", async(mainClass, projectRoot) => {
            vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot)), {
                type: "kotlin",
                name: "Run Kotlin main",
                request: "launch",
                noDebug: true,
                mainClass,
                projectRoot,
            }) 
        });
        
        vscode.commands.registerCommand("kotlin.debugMain", async(mainClass, projectRoot) => {
            vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot)), {
                type: "kotlin",
                name: "Debug Kotlin main",
                request: "launch",
                mainClass,
                projectRoot,
            }) 
        });
    }

    await languageClientPromise;

    return new KotlinApi(languageClient);
}

function createLanguageClient(
    outputChannel: vscode.OutputChannel,
    serverConnectionOptions: ServerOptions,
    storagePath: string,
    fileEventsGlobPatterns: string[]
): LanguageClient {
    // Options to control the language client
    // default error handler reconnects to a server
    // if connection is not repeatedly lost over 3 seconds
    const clientOptions: LanguageClientOptions = {
        // Register the server for Kotlin documents
        documentSelector: [
            { language: 'kotlin', scheme: 'file' },
            { language: 'kotlin', scheme: 'kls' }
        ],
        synchronize: {
            // Synchronize the setting section 'kotlin' to the server
            // NOTE: this currently doesn't do anything
            configurationSection: 'kotlin',
            // Notify the server about file changes to 'javaconfig.json' files contain in the workspace
            // TODO this should be registered from the language server side
            fileEvents: fileEventsGlobPatterns.map(
                (globPattern: string): vscode.FileSystemWatcher => {
                    return vscode.workspace.createFileSystemWatcher(globPattern)
                }
            )
        },
        progressOnInitialization: true,
        outputChannel: outputChannel,
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        // this is sent to the server
        initializationOptions: {
            storagePath,
        },
    }

    return new LanguageClient("kotlin", "Kotlin Language Client", serverConnectionOptions, clientOptions);
}

/**
 * 
 * @param outputChannel 
 * @param startScriptPath 
 * @param tcpPort `null` for random port
 * @returns 
 */
function tcp_launch(
    outputChannel: vscode.OutputChannel,
    startScriptPath: string,
    tcpPort: number | null
): Promise<StreamInfo> {
    return new Promise((resolve, reject) => {
        LOG.info("Creating server.")

        // You can't have two client sockets connect to each other
        // so need server to establish connection to a single client
        const server = net.createServer(socket => {
            LOG.info("Closing server since client has connected.");
            // do not accept new and keep existing connections
            server.close();
            resolve({ reader: socket, writer: socket });
        });

        // callback is executed once server is ready to accept connections
        server.listen(tcpPort, () => {
            const tcpPort = (server.address() as net.AddressInfo).port.toString();
            const proc = child_process.spawn(startScriptPath, ["--tcpClientPort", tcpPort]);
            LOG.info("Creating client at {} via TCP port {}", startScriptPath, tcpPort);
            
            const outputCallback = data => outputChannel.append(`${data}`);
            proc.stdout.on("data", outputCallback);
            proc.stderr.on("data", outputCallback);
            proc.on("exit", (code, sig) => outputChannel.appendLine(`The language server exited, code: ${code}, signal: ${sig}`))
        });
        server.on("error", e => reject(e));
    });
}

function tcp_attach(
    _outputChannel: vscode.OutputChannel,
    tcpPort: number
): ServerOptions {
    const server = net.createServer()
    server.listen(tcpPort)

    // returned function is called during every start, recreating connection
    return () => {
        return new Promise((resolve, _reject) => {
            server.removeAllListeners("connect")
            
            const connection_listener = (socket: net.Socket) => {
                socket.once("close", () => {
                    server.removeListener("connect", connection_listener)
                })
                
                resolve({ reader: socket, writer: socket })
            }

            server.once("connection", connection_listener)
        })
    }
}

function stdio_launch(startPath: string, env: any, debugConfiguration: TServerDebugConfig): ServerOptions {
    if (debugConfiguration.is_enabled) {
        env['KOTLIN_LANGUAGE_SERVER_OPTS'] = `-Xdebug -agentlib:jdwp=transport=dt_socket,address=${debugConfiguration.port},server=y,quiet=y,suspend=${debugConfiguration.auto_suspend ? "y" : "n"}`;
    }

    return {
        command: startPath,
        args: [],
        options: {
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath,
            env: env
        } // TODO: Support multi-root workspaces (and improve support for when no available is available)
    }
}


