'use strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerDebugAdapter } from './debugSetup';
import { InternalConfigManager } from './internalConfig';
import { findJavaInstallation, findJavaOpts } from './javaSetup';
import { activateLanguageServer } from './languageSetup';
import { ServerSetupParams } from './setupParams';
import { fsExists } from './util/fsUtils';
import { LOG } from './util/logger';
import { Status, StatusBarEntry } from './util/status';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    configureLanguage();

    const kotlinConfig = vscode.workspace.getConfiguration("kotlin");
    let langServerEnabled = kotlinConfig.get("languageServer.enabled");
    let debugAdapterEnabled = kotlinConfig.get("debugAdapter.enabled");
    
    const globalStoragePath = context.globalStorageUri.fsPath;
    if (!(await fsExists(globalStoragePath))) {
        await fs.promises.mkdir(globalStoragePath);
    }
    
    const internalConfigPath = path.join(globalStoragePath, "config.json");
    const internalConfigManager = await InternalConfigManager.loadingConfigFrom(internalConfigPath);
    
    if (!internalConfigManager.getConfig().initialized) {
        const message = "The Kotlin extension will automatically download a language server and a debug adapter to provide code completion, linting, debugging and more. If you prefer to install these yourself, you can provide custom paths or disable them in your settings. The language server and debug adapter require JDK 11+ and currently only support Maven and Gradle projects.";
        const continueButton = "Ok, continue";
        const disableButton = "Disable";
        const result = await vscode.window.showInformationMessage(message, continueButton, disableButton);
        
        await internalConfigManager.updateConfig({ initialized: true });

        if (!result || result === disableButton) {
            await kotlinConfig.update("languageServer.enabled", false, vscode.ConfigurationTarget.Global);
            await kotlinConfig.update("debugAdapter.enabled", false, vscode.ConfigurationTarget.Global);

            // these values are not yet updated even if we move the above get-calls down. Works the next time the extension is opened
            langServerEnabled = false;
            debugAdapterEnabled = false;

            await vscode.window.showWarningMessage("Only syntax highlighting will be available for Kotlin. If you would like to enable the language server/debug adapter in the future, you can enable them in your settings.");
            return;
        }
    }

    const initTasks: Promise<void>[] = [];
    const javaInstallation = await findJavaInstallation();

    if (!javaInstallation) {
        await vscode.window.showWarningMessage("Could neither locate Java in JAVA_HOME, on PATH nor in kotlin.java.home!");
        return;
    }

    const javaOpts = await findJavaOpts();
    const setupParams: (status: Status) => ServerSetupParams = status => ({
        context,
        status,
        config: kotlinConfig,
        javaInstallation,
        javaOpts
    });
    
    if (langServerEnabled) {
        // this should be reentrant
        // when connection is dropped (how to know this?)
        // consider the server as dead. Await for new connection
        initTasks.push(withSpinningStatus(context, async status => {
            await activateLanguageServer(setupParams(status));
        }));
    } else {
        LOG.info("Skipping language server activation since 'kotlin.languageServer.enabled' is false");
    }
    
    if (debugAdapterEnabled) {
        initTasks.push(withSpinningStatus(context, async status => {
            await registerDebugAdapter(setupParams(status));
        }));
    } else {
        LOG.info("Skipping debug adapter registration since 'kotlin.debugAdapter.enabled' is false");
    }
    
    await Promise.all(initTasks);
}

async function withSpinningStatus(context: vscode.ExtensionContext, action: (status: Status) => Promise<void>): Promise<void> {
    const status = new StatusBarEntry(context, "$(sync~spin)");
    status.show();
    await action(status);
    status.dispose();
}

// this method is called when your extension is deactivated
export function deactivate(): void {}

function configureLanguage(): void {
    // Source: https://github.com/Microsoft/vscode/blob/9d611d4dfd5a4a101b5201b8c9e21af97f06e7a7/extensions/typescript/src/typescriptMain.ts#L186
    // License: https://github.com/Microsoft/vscode/blob/9d611d4dfd5a4a101b5201b8c9e21af97f06e7a7/extensions/typescript/OSSREADME.json
    vscode.languages.setLanguageConfiguration("kotlin", {
        indentationRules: {
            // ^(.*\*/)?\s*\}.*$
            decreaseIndentPattern: /^(.*\*\/)?\s*\}.*$/,
            // ^.*\{[^}"']*$
            increaseIndentPattern: /^.*\{[^}"']*$/
        },
        wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
        onEnterRules: [
            {
                // e.g. /** | */
                beforeText: /^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/,
                afterText: /^\s*\*\/$/,
                action: { indentAction: vscode.IndentAction.IndentOutdent, appendText: ' * ' }
            },
            {
                // e.g. /** ...|
                beforeText: /^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/,
                action: { indentAction: vscode.IndentAction.None, appendText: ' * ' }
            },
            {
                // e.g.  * ...|
                beforeText: /^(\t|(\ \ ))*\ \*(\ ([^\*]|\*(?!\/))*)?$/,
                action: { indentAction: vscode.IndentAction.None, appendText: '* ' }
            },
            {
                // e.g.  */|
                beforeText: /^(\t|(\ \ ))*\ \*\/\s*$/,
                action: { indentAction: vscode.IndentAction.None, removeText: 1 }
            },
            {
                // e.g.  *-----*/|
                beforeText: /^(\t|(\ \ ))*\ \*[^/]*\*\/\s*$/,
                action: { indentAction: vscode.IndentAction.None, removeText: 1 }
            }
        ]
    });
}

