import { TextDocument } from "vscode-languageserver-textdocument";
import { CodeActionKind, type CodeAction } from "vscode-languageserver";
import {
  createConnection,
  TextDocuments,
  TextDocumentSyncKind,
  type Connection,
  type InitializeParams,
  type InitializeResult,
} from "vscode-languageserver/node";
import {
  ALL_COMMANDS,
  CMD_CREATE_COMMENT_DRAFT,
  CMD_DELETE_COMMENT,
  CMD_DRAFT_REVIEW,
  CMD_LIST_COMMENTS,
  CMD_POST_DRAFTS,
  CMD_REACT,
  CMD_REFRESH,
  CMD_REMOVE_REACTION,
  CMD_RESOLVE_THREAD,
  CMD_SUMMARY,
  CMD_VIEW_ON_GITHUB,
  REACTIONS,
} from "./commands";
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

function quickFix(title: string, command: string, args: unknown[]): CodeAction {
  return {
    title,
    kind: CodeActionKind.QuickFix,
    command: { title, command, arguments: args },
  };
}

const EMOJI_BY_CONTENT: Record<string, string> = Object.fromEntries(
  REACTIONS.map((r) => [r.content, r.emoji]),
);

export function createHost(): ServerHost {
  const connection = createConnection();
  const documents = new TextDocuments(TextDocument);
  return {
    connection,
    documents,
    config: { githubBaseUrl: "", inlayHints: true, draftsDir: ".pr-review", pollIntervalMs: 30_000 },
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
    void (async () => {
      await state.refresh();
      await state.publishAll();
      state.startBackgroundPoll();
    })();
  });

  connection.onShutdown(() => {
    state.stopBackgroundPoll();
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
    void (async () => {
      if (await state.handleDraftSave(e.document.uri)) return;
      await state.publishForDoc(e.document.uri);
    })();
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

  connection.onCodeAction(async (params) => {
    const doc = host.documents.get(params.textDocument.uri);
    if (!doc || !state.pr) return [];
    const actions: CodeAction[] = [];
    const anchored = state.anchoredThreadsForDoc(doc);
    const sel = params.range;
    const hits = anchored.filter((t) => t.anchor.line >= sel.start.line && t.anchor.line <= sel.end.line);
    for (const t of hits) {
      for (const r of REACTIONS) {
        actions.push(quickFix(`React ${r.emoji}`, CMD_REACT, [t.top.id, r.content]));
      }
      actions.push(quickFix(`Reply to @${t.top.user?.login ?? "commenter"}…`, CMD_CREATE_COMMENT_DRAFT, [doc.uri, t.anchor.line + 1, t.top.id]));
      if (t.threadId) {
        const resolved = t.isResolved === true;
        actions.push(quickFix(resolved ? "Unresolve thread" : "Resolve thread", CMD_RESOLVE_THREAD, [t.threadId, !resolved]));
      }
      actions.push(quickFix("View on GitHub", CMD_VIEW_ON_GITHUB, [t.top.html_url]));
      const me = await state.whoAmI();
      if (me) {
        for (const c of [t.top, ...t.replies]) {
          if (c.user?.login === me) {
            actions.push(
              quickFix(c === t.top ? "Delete comment (you)" : "Delete reply (you)", CMD_DELETE_COMMENT, [c.id]),
            );
          }
        }
        for (const content of await state.myReactionContents(t.top.id)) {
          actions.push(
            quickFix(`Remove ${EMOJI_BY_CONTENT[content] ?? content} (you)`, CMD_REMOVE_REACTION, [t.top.id, content]),
          );
        }
      }
    }
    const selectionNonEmpty =
      sel.start.line !== sel.end.line || sel.start.character !== sel.end.character;
    // New inline comment: offered for any non-empty selection (on top of
    // thread actions if one intersects), and also for a collapsed cursor
    // when no thread is under it. Clients vary on whether they forward
    // selections as non-empty ranges; a silent missing entry point is worse.
    if (selectionNonEmpty || hits.length === 0) {
      const rel = state.relativePath(doc.uri);
      if (rel) {
        actions.push(quickFix("Add PR review comment…", CMD_CREATE_COMMENT_DRAFT, [doc.uri, sel.start.line + 1]));
      }
    }
    return actions;
  });

  connection.onExecuteCommand(async (params) => {
    const args = params.arguments ?? [];
    try {
      switch (params.command) {
        case CMD_REFRESH:
          await state.refresh(true);
          await state.publishAll();
          break;
        case CMD_REACT:
          await state.reactTo(Number(args[0]), String(args[1]));
          break;
        case CMD_RESOLVE_THREAD:
          await state.toggleThread(String(args[0]), args[1] !== false);
          break;
        case CMD_DELETE_COMMENT:
          await state.deleteComment(Number(args[0]));
          break;
        case CMD_REMOVE_REACTION:
          await state.removeReaction(Number(args[0]), String(args[1]));
          break;
        case CMD_VIEW_ON_GITHUB:
          state.viewOnGithub(String(args[0]));
          break;
        case CMD_CREATE_COMMENT_DRAFT: {
          if (args.length >= 3 && args[2] !== null && args[2] !== undefined) {
            state.createReplyDraft(Number(args[2]));
            break;
          }
          const rel = state.relativePath(String(args[0]));
          if (rel) state.createCommentDraft(rel, Number(args[1]));
          break;
        }
        case CMD_DRAFT_REVIEW:
          state.createReviewDraft();
          break;
        case CMD_SUMMARY: {
          await state.refresh(true);
          if (!state.pr) {
            void connection.window.showInformationMessage("pr-review: no open PR for this branch");
            break;
          }
          const top = state.comments.filter((c) => c.in_reply_to_id === null);
          void connection.window.showInformationMessage(
            `pr-review: PR #${state.pr.number} · ${top.length} threads · ${state.countStale()} outdated`,
          );
          break;
        }
        case CMD_LIST_COMMENTS:
          await state.refresh(true);
          if (!state.pr) {
            void connection.window.showInformationMessage("pr-review: no open PR for this branch");
            break;
          }
          await state.listComments();
          break;
        case CMD_POST_DRAFTS:
          await state.postDrafts();
          break;
        default:
          break;
      }
    } catch (e) {
      void connection.window.showErrorMessage(`pr-review: ${String(e instanceof Error ? e.message : e)}`);
    }
    return null;
  });

  // Document handlers must be installed before the RPC loop starts, or an
  // early didOpen can race past them.
  host.documents.listen(connection);
  connection.listen();
}

if (require.main === module || process.argv[1]?.endsWith("server.js")) {
  wireLifecycle(createHost());
}
