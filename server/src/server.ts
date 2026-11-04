import {
  createConnection,
  TextDocuments,
  TextDocumentSyncKind,
  type Connection,
  type InitializeParams,
  type InitializeResult,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ALL_COMMANDS } from "./commands";
import { configFromSettings, type EffectiveConfig } from "./config";
import { buildHoverMarkdown } from "./hover";
import { buildInlayHints } from "./inlayhints";
import { AppState } from "./state";

export interface ServerHost {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  config: EffectiveConfig;
  workspaceRoot: string | null;
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
  const state = new AppState(host);

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    host.workspaceRoot =
      params.workspaceFolders && params.workspaceFolders.length > 0
        ? params.workspaceFolders[0].uri
        : (params.rootUri ?? null);
    host.config = configFromSettings(params.initializationOptions?.settings);

    return {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Incremental,
          save: { includeText: false },
        },
        hoverProvider: true,
        codeActionProvider: true,
        inlayHintProvider: true,
        executeCommandProvider: { commands: ALL_COMMANDS },
      },
    };
  });

  connection.onInitialized(() => {
    void state.refresh().then(() => state.publishAll());
  });

  connection.onDidChangeConfiguration(({ settings }) => {
    host.config = configFromSettings(settings);
  });

  host.documents.onDidOpen((e) => {
    state.savedVersions.set(e.document.uri, e.document.version);
    void (async () => {
      await state.refresh();
      await state.publishForDoc(e.document.uri);
    })();
  });

  host.documents.onDidSave((e) => {
    const doc = host.documents.get(e.document.uri);
    if (doc) state.savedVersions.set(doc.uri, doc.version);
    void state.publishForDoc(e.document.uri);
  });

  host.documents.onDidClose((e) => {
    state.savedVersions.delete(e.document.uri);
  });

  connection.onHover((params) => {
    const doc = host.documents.get(params.textDocument.uri);
    if (!doc || !state.pr) return null;
    const hits = state
      .anchoredThreadsForDoc(doc)
      .filter((t) => t.anchor.line === params.position.line);
    const md = buildHoverMarkdown(state.pr.number, state.pr.html_url, hits, Date.now());
    if (md === null) return null;
    return { contents: { kind: "markdown", value: md } };
  });
  connection.languages.inlayHint.on((params) => {
    const doc = host.documents.get(params.textDocument.uri);
    if (!doc || !state.pr || !host.config.inlayHints) return [];
    const positions = new Map<number, number>();
    for (const t of state.anchoredThreadsForDoc(doc)) {
      positions.set(t.anchor.line, (positions.get(t.anchor.line) ?? 0) + 1);
    }
    const lineLengths = doc.getText().split(/\r?\n/).map((l) => l.length);
    return buildInlayHints(state.pr.number, lineLengths, positions);
  });

  connection.onCodeAction(() => []);

  connection.listen();
  host.documents.listen(connection);
}

if (require.main === module || process.argv[1]?.endsWith("server.js")) {
  wireLifecycle(createHost());
}
