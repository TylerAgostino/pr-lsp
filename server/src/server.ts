import {
  createConnection,
  TextDocuments,
  type Connection,
  type InitializeParams,
  type InitializeResult,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ALL_COMMANDS } from "./commands";
import { configFromSettings, type EffectiveConfig } from "./config";

export interface ServerHost {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  config: EffectiveConfig;
  workspaceRoot: string | null;
}

/**
 * Pull-request context for the current workspace branch. Resolved in step 3;
 * until then the server stays silent (empty diagnostics, no actions).
 */
export interface Context {
  resolved: boolean;
}

export function createHost(): ServerHost {
  const connection = createConnection();
  const documents = new TextDocuments(TextDocument);
  return {
    connection,
    documents,
    config: { githubBaseUrl: "", inlayHints: true, draftsDir: ".git/pr-review" },
    workspaceRoot: null,
  };
}

export function wireLifecycle(host: ServerHost): void {
  const { connection } = host;

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    host.workspaceRoot =
      params.workspaceFolders && params.workspaceFolders.length > 0
        ? params.workspaceFolders[0].uri
        : (params.rootUri ?? null);
    host.config = configFromSettings(params.initializationOptions?.settings);

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        codeActionProvider: true,
        inlayHintProvider: true,
        executeCommandProvider: { commands: ALL_COMMANDS },
      },
    };
  });

  connection.onDidChangeConfiguration(({ settings }) => {
    host.config = configFromSettings(settings);
  });

  host.documents.onDidOpen((e) => {
    void refreshDiagnosticsForDocument(host, e.document.uri);
  });

  connection.listen();
  host.documents.listen(connection);
}

/**
 * Publish diagnostics for one open document. Step 2: always empty (no PR
 * data yet); later steps resolve anchors and publish real threads.
 */
export async function refreshDiagnosticsForDocument(
  host: ServerHost,
  _uri: string,
): Promise<void> {
  host.connection.sendDiagnostics({ uri: _uri, diagnostics: [] });
}

if (require.main === module || process.argv[1]?.endsWith("server.js")) {
  wireLifecycle(createHost());
}
