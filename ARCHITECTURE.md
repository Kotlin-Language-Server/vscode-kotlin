
# LanguageClient

Language client is a long running object. It is created in our extension. It communicates with vscode by calling static methods provided via `vscode` module. This module is special: it is NOT located in `node_modules` but is loaded by vscode during runtime.

I suppose, Language client is kept alive due to registered callbacks. Callbacks are registered for node js communication primitives like sockets and streams. Since language server is accessible from them, it is kept in memory.



