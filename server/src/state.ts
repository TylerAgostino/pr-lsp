import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { anchorToBuffer, type Anchor } from "./anchor";
import { resolveToken } from "./auth";
import { draftDir, draftSeedBody, isDraftPath, parseDraft, writeDraft } from "./drafts";
import { buildDiagnostics, type AnchoredThread } from "./diagnostics";
import { resolveRepo, type RepoInfo } from "./git";
import { GithubClient, type PullRequest, type ReviewComment, type ThreadState } from "./github";
import { attachThreadState, groupThreads, type Thread } from "./model";
import { type ServerHost } from "./server";

export class AppState {
  repo: RepoInfo | null = null;
  pr: PullRequest | null = null;
  comments: ReviewComment[] = [];
  threadStates = new Map<number, ThreadState>();
  /** Last saved LSP version per open doc; a doc is dirty when its current
   *  version differs (didOpen also fires didChange, so versions are the
   *  reliable signal). */
  savedVersions = new Map<string, number>();

  private refreshed: Promise<void> | null = null;

  constructor(readonly host: ServerHost) {}

  isDirty(doc: TextDocument): boolean {
    const saved = this.savedVersions.get(doc.uri);
    return saved !== undefined && saved !== doc.version;
  }
  get enabled(): boolean {
    return this.repo !== null && this.repo.remote !== null && this.pr !== null;
  }

  client(): GithubClient | null {
    if (!this.repo?.remote) return null;
    const token = resolveToken();
    if (!token) return null;
    return new GithubClient(this.host.config, token);
  }

  /** (Re)resolve repo + PR data. Concurrent calls share one pass. */
  refresh(force = false): Promise<void> {
    if (this.refreshed && !force) return this.refreshed;
    const run = async (): Promise<void> => {
      try {
        await this.refreshInner();
      } catch (e) {
        this.log(`refresh failed: ${String(e instanceof Error ? e.message : e)}`);
      }
    };
    this.refreshed = run();
    return this.refreshed;
  }

  private async refreshInner(): Promise<void> {
    if (!this.host.workspaceRoot) {
      this.clear();
      return;
    }
    const root = fileURLToPath(this.host.workspaceRoot);
    this.repo = await resolveRepo(root);
    if (!this.repo || !this.repo.remote) {
      this.clear();
      return;
    }
    const { owner, repo } = this.repo.remote;
    const client = this.client();
    if (!client) {
      // Auth missing: stay silent; nothing to show until configured.
      this.pr = null;
      this.comments = [];
      return;
    }
    const pr = await client.getOpenPrForBranch(owner, repo, this.repo.branch);
    this.pr = pr;
    if (!pr) {
      this.comments = [];
      this.threadStates = new Map();
      return;
    }
    const [comments, threads] = await Promise.all([
      client.listReviewComments(owner, repo, pr.number),
      client.getThreads(owner, repo, pr.number),
    ]);
    this.comments = comments;
    this.threadStates = threads;
  }

  private clear(): void {
    this.repo = null;
    this.pr = null;
    this.comments = [];
    this.threadStates = new Map();
  }

  log(msg: string): void {
    this.host.connection.console.log(`pr-review: ${msg}`);
  }

  /** Workspace-relative, slash-separated path for a file:// doc uri. */
  relativePath(uri: string): string | null {
    if (!this.repo) return null;
    let fsPath: string;
    try {
      fsPath = fileURLToPath(uri);
    } catch {
      return null;
    }
    const rel = path.relative(this.repo.root, fsPath).split(path.sep).join("/");
    if (rel.startsWith("..") || rel.length === 0) return null;
    return rel;
  }

  /** Threads anchored to `doc`; stale threads carry state "stale". */
  threadsForDoc(doc: TextDocument): Thread[] {
    const rel = this.relativePath(doc.uri);
    if (!rel || !this.pr || !this.repo) return [];
    const inFile = this.comments.filter((c) => c.path === rel);
    const threads = groupThreads(inFile);
    attachThreadState(threads, this.threadStates);
    return threads;
  }

  anchorThread(doc: TextDocument, thread: Thread): Anchor {
    const lines = doc.getText().split(/\r?\n/);
    const dirty = this.isDirty(doc);
    return anchorToBuffer(lines, thread.top, this.repo?.headSha ?? "", dirty);
  }

  anchoredThreadsForDoc(doc: TextDocument): AnchoredThread[] {
    const out: AnchoredThread[] = [];
    for (const t of this.threadsForDoc(doc)) {
      const anchor = this.anchorThread(doc, t);
      if (anchor.state === "line") out.push({ ...t, anchor });
    }
    return out;
  }

  countStale(): number {
    if (!this.pr || !this.repo) return 0;
    let stale = 0;
    for (const c of this.comments) {
      if (c.in_reply_to_id !== null) continue;
      if (c.line === null && c.position === null) stale += 1;
    }
    return stale;
  }

  /** Publish diagnostics for one open document (empty when nothing applies). */
  async publishForDoc(uri: string): Promise<void> {
    const doc = this.host.documents.get(uri);
    if (!doc) return;
    const lineLengths = doc.getText().split(/\r?\n/).map((l) => l.length);
    const diags = buildDiagnostics(lineLengths, this.anchoredThreadsForDoc(doc));
    this.host.connection.sendDiagnostics({ uri, diagnostics: diags });
  }

  async publishAll(): Promise<void> {
    for (const doc of this.host.documents.all()) await this.publishForDoc(doc.uri);
  }

  private requireClient(): GithubClient {
    const c = this.client();
    if (!c) throw new Error("no GitHub token; set GITHUB_TOKEN or use gh auth");
    return c;
  }

  private remote(): { owner: string; repo: string } {
    if (!this.repo?.remote) throw new Error("no GitHub remote");
    return this.repo.remote;
  }

  private error(msg: string): void {
    void this.host.connection.window.showErrorMessage(`pr-review: ${msg}`);
  }

  async reactTo(commentId: number, content: string): Promise<void> {
    const { owner, repo } = this.remote();
    await this.requireClient().addReaction(owner, repo, commentId, content);
    await this.refresh(true);
    await this.publishAll();
  }

  async toggleThread(threadId: string, resolved: boolean): Promise<void> {
    const { owner, repo } = this.remote();
    const ok = await this.requireClient().setThreadResolved(owner, repo, threadId, resolved);
    if (!ok) throw new Error(`could not ${resolved ? "resolve" : "unresolve"} thread`);
    await this.refresh(true);
    await this.publishAll();
  }

  viewOnGithub(url: string): void {
    void this.host.connection.sendRequest("window/showDocument", { uri: url, external: true });
  }

  private openDraftInEditor(file: string): void {
    void this.host.connection.sendRequest("window/showDocument", {
      uri: pathToFileURL(file).href,
      external: false,
    });
  }

  createReplyDraft(commentId: number): string | null {
    if (!this.pr || !this.repo) return null;
    const file = writeDraft(
      draftDir(this.repo.root, this.host.config.draftsDir),
      { type: "reply", pr: this.pr.number, comment: commentId },
      draftSeedBody("reply", {}),
    );
    this.openDraftInEditor(file);
    return file;
  }

  createCommentDraft(relPath: string, line: number): string | null {
    if (!this.pr || !this.repo) return null;
    const file = writeDraft(
      draftDir(this.repo.root, this.host.config.draftsDir),
      { type: "comment", pr: this.pr.number, path: relPath, line },
      draftSeedBody("comment", { path: relPath, line }),
    );
    this.openDraftInEditor(file);
    return file;
  }

  createReviewDraft(): string | null {
    if (!this.pr || !this.repo) return null;
    const file = writeDraft(
      draftDir(this.repo.root, this.host.config.draftsDir),
      { type: "review", pr: this.pr.number, event: "comment" },
      draftSeedBody("review", {}),
    );
    this.openDraftInEditor(file);
    return file;
  }

  /** Handles saving a draft file: posts to GitHub, deletes on success. */
  async handleDraftSave(uri: string): Promise<boolean> {
    if (!this.repo) return false;
    let fsPath: string;
    try {
      fsPath = fileURLToPath(uri);
    } catch {
      return false;
    }
    if (!isDraftPath(fsPath, draftDir(this.repo.root, this.host.config.draftsDir))) return false;
    let text: string;
    try {
      text = fs.readFileSync(fsPath, "utf8");
    } catch {
      return true;
    }
    const parsed = parseDraft(text);
    if (!parsed) {
      this.error(`ignoring ${path.basename(fsPath)}: missing or invalid draft frontmatter`);
      return true;
    }
    if (!this.pr || parsed.meta.pr !== this.pr.number) {
      this.error(`draft targets PR #${parsed.meta.pr}, current PR is #${this.pr?.number ?? "none"}`);
      return true;
    }
    if (parsed.meta.type !== "review" && parsed.body.length === 0) return true;
    try {
      const { owner, repo } = this.remote();
      const client = this.requireClient();
      if (parsed.meta.type === "reply") {
        await client.replyToComment(owner, repo, parsed.meta.pr, parsed.meta.comment as number, parsed.body);
      } else if (parsed.meta.type === "comment") {
        await client.createReviewComment(
          owner,
          repo,
          parsed.meta.pr,
          parsed.body,
          parsed.meta.path as string,
          parsed.meta.line as number,
        );
      } else {
        const event = (parsed.meta.event || "comment").toUpperCase();
        await client.submitReview(owner, repo, parsed.meta.pr, event, parsed.body);
      }
      fs.unlinkSync(fsPath);
      await this.refresh(true);
      await this.publishAll();
    } catch (e) {
      this.error(`failed to post ${path.basename(fsPath)}: ${String(e instanceof Error ? e.message : e)}`);
    }
    return true;
  }
}
