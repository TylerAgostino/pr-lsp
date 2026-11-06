import { apiRoot, type EffectiveConfig } from "./config";
import { isRecord, optNum, str } from "./boundary";

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodyText: string,
  ) {
    super(`GitHub API ${status} for ${url}: ${bodyText.slice(0, 200)}`);
    this.name = "GithubApiError";
  }
}

export interface GithubUser {
  login: string;
}

/** GitHub's flattened reaction counters on comment payloads. */
export interface ReactionCounts {
  total_count?: number;
  "+1"?: number;
  "-1"?: number;
  laugh?: number;
  hooray?: number;
  confused?: number;
  heart?: number;
  rocket?: number;
  eyes?: number;
}

export interface ReviewComment {
  id: number;
  body: string;
  path: string;
  /** Current RIGHT-side line of the latest push, null when file was removed. */
  line: number | null;
  original_line: number | null;
  side: "LEFT" | "RIGHT";
  diff_hunk: string;
  user: GithubUser | null;
  created_at: string;
  html_url: string;
  pull_request_url: string;
  commit_id: string;
  /** 1-based index within diff_hunk (including @@ header); null when unmapped. */
  position: number | null;
  in_reply_to_id: number | null;
  reactions: ReactionCounts;
}

export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  head: { sha: string };
}

export interface ReviewSummary {
  id: number;
  submitter: string;
  submitted_at: string;
  state: string;
}

export interface ThreadState {
  threadId: string;
  isResolved: boolean;
}

const API_VERSION = "2022-11-28";

/** GraphQL endpoint paired with a REST base (`/api/v3` → `/api/graphql`). */
export function graphqlRoot(cfg: EffectiveConfig): string {
  const rest = apiRoot(cfg);
  if (rest.endsWith("/api/v3")) {
    return `${rest.slice(0, -"/v3".length)}/graphql`;
  }
  return `${rest}/graphql`;
}

async function http(
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "pr-review-lsp",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new GithubApiError(res.status, url, text);
  if (text.length === 0) return null;
  return JSON.parse(text) as unknown;
}

// Boundary helpers come from ./boundary (canonical guards).

export function parseReviewComment(v: unknown): ReviewComment | null {
  if (!isRecord(v) || typeof v.id !== "number" || typeof v.body !== "string") return null;
  if (typeof v.path !== "string") return null;
  const user = isRecord(v.user) && typeof v.user.login === "string" ? { login: v.user.login } : null;
  return {
    id: v.id,
    body: v.body,
    path: v.path,
    line: optNum(v.line),
    original_line: optNum(v.original_line),
    side: v.side === "LEFT" ? "LEFT" : "RIGHT",
    diff_hunk: str(v.diff_hunk),
    user,
    position: optNum(v.position),
    created_at: str(v.created_at),
    html_url: str(v.html_url),
    pull_request_url: str(v.pull_request_url),
    commit_id: str(v.commit_id),
    in_reply_to_id: optNum(v.in_reply_to_id),
    reactions: isRecord(v.reactions) ? (v.reactions as ReactionCounts) : {},
  };
}

export function parsePullRequest(v: unknown): PullRequest | null {
  if (!isRecord(v)) return null;
  const n = optNum(v.number);
  if (n === null) return null;
  const head = isRecord(v.head) ? { sha: str(v.head.sha) } : { sha: "" };
  return { number: n, title: str(v.title), html_url: str(v.html_url), head };
}

// --- client ---

export class GithubClient {
  constructor(
    private cfg: EffectiveConfig,
    private token: string,
  ) {}

  private repoBase(owner: string, repo: string): string {
    return `${apiRoot(this.cfg)}/repos/${owner}/${repo}`;
  }

  /** Open PR whose head branch equals `branch` (newest update wins). */
  async getOpenPrForBranch(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
    const url = `${this.repoBase(owner, repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&sort=updated&per_page=100`;
    const data = await http("GET", url, this.token);
    if (!Array.isArray(data)) return null;
    const prs = data.map(parsePullRequest).filter((p): p is PullRequest => p !== null);
    if (prs.length === 0) return null;
    return prs[0];
  }

  /** All review comments on a PR (paginated). */
  async listReviewComments(owner: string, repo: string, prNumber: number): Promise<ReviewComment[]> {
    const out: ReviewComment[] = [];
    for (let page = 1; ; page += 1) {
      const url = `${this.repoBase(owner, repo)}/pulls/${prNumber}/comments?per_page=100&page=${page}`;
      const data = await http("GET", url, this.token);
      if (!Array.isArray(data)) break;
      for (const item of data) {
        const c = parseReviewComment(item);
        if (c) out.push(c);
      }
      if (data.length < 100) break;
    }
    return out;
  }

  /** All reviews on a PR (newest kept per submitter by callers). */
  async listReviews(owner: string, repo: string, prNumber: number): Promise<ReviewSummary[]> {
    const url = `${this.repoBase(owner, repo)}/pulls/${prNumber}/reviews?per_page=100`;
    const data = await http("GET", url, this.token);
    if (!Array.isArray(data)) return [];
    const out: ReviewSummary[] = [];
    for (const r of data) {
      if (!isRecord(r) || typeof r.id !== "number") continue;
      const user = isRecord(r.user) && typeof r.user.login === "string" ? r.user.login : "unknown";
      out.push({
        id: r.id,
        submitter: user,
        submitted_at: str(r.submitted_at),
        state: str(r.state),
      });
    }
    return out;
  }

  async listCheckRuns(owner: string, repo: string, sha: string): Promise<{ name: string; conclusion: string | null }[]> {
    const url = `${this.repoBase(owner, repo)}/commits/${sha}/check-runs?per_page=100`;
    const data = await http("GET", url, this.token);
    if (!isRecord(data) || !Array.isArray(data.check_runs)) return [];
    const out: { name: string; conclusion: string | null }[] = [];
    for (const c of data.check_runs) {
      if (isRecord(c)) out.push({ name: str(c.name), conclusion: typeof c.conclusion === "string" ? c.conclusion : null });
    }
    return out;
  }

  /**
   * Standalone line-note comment. Falls back to a COMMENT review carrying
   * the single comment if GitHub rejects the direct endpoint (422 drift).
   */
  async createReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    path: string,
    line: number,
  ): Promise<void> {
    try {
      await http("POST", `${this.repoBase(owner, repo)}/pulls/${prNumber}/comments`, this.token, { body, path, line, side: "RIGHT" });
    } catch (e) {
      if (e instanceof GithubApiError && e.status === 422) {
        await http("POST", `${this.repoBase(owner, repo)}/pulls/${prNumber}/reviews`, this.token, {
          event: "COMMENT",
          comments: [{ path, line, side: "RIGHT", body }],
        });
        return;
      }
      throw e;
    }
  }

  async replyToComment(
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void> {
    const url = `${this.repoBase(owner, repo)}/pulls/${prNumber}/comments/${commentId}/replies`;
    await http("POST", url, this.token, { body });
  }

  async addReaction(owner: string, repo: string, commentId: number, content: string): Promise<void> {
    const url = `${this.repoBase(owner, repo)}/pulls/comments/${commentId}/reactions`;
    await http("POST", url, this.token, { content });
  }

  async submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    event: string,
    body: string,
  ): Promise<void> {
    const url = `${this.repoBase(owner, repo)}/pulls/${prNumber}/reviews`;
    await http("POST", url, this.token, { event, body });
  }

  private async gql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const data = await http("POST", graphqlRoot(this.cfg), this.token, { query, variables });
    if (!isRecord(data)) return null;
    if (data.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(data.errors).slice(0, 300)}`);
    return data.data;
  }

  /** Map of comment databaseId -> review thread state for a PR. */
  async getThreads(owner: string, repo: string, prNumber: number): Promise<Map<number, ThreadState>> {
    const q = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId}}}}}}}`;
    const data = await this.gql(q, { owner, name: repo, number: prNumber });
    const map = new Map<number, ThreadState>();
    if (!isRecord(data)) return map;
    const repoNode = isRecord(data.repository) ? data.repository : null;
    const pr = repoNode && isRecord(repoNode.pullRequest) ? repoNode.pullRequest : null;
    // GraphQL connections arrive as { nodes: [...] }
    const rt = pr && isRecord(pr.reviewThreads) ? pr.reviewThreads : null;
    const threads = rt && Array.isArray(rt.nodes) ? rt.nodes : null;
    if (!threads) return map;
    for (const t of threads) {
      if (!isRecord(t) || typeof t.id !== "string") continue;
      const isResolved = t.isResolved === true;
      const cm = isRecord(t.comments) ? t.comments : null;
      const comments = cm && Array.isArray(cm.nodes) ? cm.nodes : [];
      for (const c of comments) {
        if (isRecord(c) && typeof c.databaseId === "number") {
          // top-level comment wins so replies never override the anchor id
          if (!map.has(c.databaseId)) map.set(c.databaseId, { threadId: t.id, isResolved });
        }
      }
    }
    return map;
  }

  async setThreadResolved(owner: string, repo: string, threadId: string, resolved: boolean): Promise<boolean> {
    const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    const m = resolved
      ? `mutation($input:ResolveReviewThreadInput!){resolveReviewThread(input:$input){thread{id isResolved}}}`
      : `mutation($input:UnresolveReviewThreadInput!){unresolveReviewThread(input:$input){thread{id isResolved}}}`;
    const data = await this.gql(m, { input: { threadId } });
    if (!isRecord(data)) return resolved;
    const node = isRecord(data[mutation]) ? data[mutation] : null;
    const thread = node && isRecord(node.thread) ? node.thread : null;
    // Success is "the thread reports the state we asked for". Comparing
    // against `true` (the old code) made every successful *unresolve*
    // look like a failure to callers.
    return thread ? thread.isResolved === resolved : resolved;
  }

  /** Login of the authenticated user (null when unknown); used to gate
   *  delete/remove-reaction affordances. */
  async getCurrentUser(): Promise<string | null> {
    const data = await http("GET", `${apiRoot(this.cfg)}/user`, this.token);
    return isRecord(data) && typeof data.login === "string" ? data.login : null;
  }

  /** Delete one review comment (works for replies too). 403 if not yours. */
  async deleteReviewComment(owner: string, repo: string, commentId: number): Promise<void> {
    await http("DELETE", `${this.repoBase(owner, repo)}/pulls/comments/${commentId}`, this.token);
  }

  /** Individual reactions on a review comment, for "remove yours". */
  async listReactions(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<{ id: number; content: string; login: string }[]> {
    const url = `${this.repoBase(owner, repo)}/pulls/comments/${commentId}/reactions?per_page=100`;
    const data = await http("GET", url, this.token);
    if (!Array.isArray(data)) return [];
    const out: { id: number; content: string; login: string }[] = [];
    for (const r of data) {
      if (!isRecord(r) || typeof r.id !== "number" || typeof r.content !== "string") continue;
      out.push({ id: r.id, content: r.content, login: isRecord(r.user) ? str(r.user.login) : "" });
    }
    return out;
  }

  async deleteReaction(owner: string, repo: string, commentId: number, reactionId: number): Promise<void> {
    await http("DELETE", `${this.repoBase(owner, repo)}/pulls/comments/${commentId}/reactions/${reactionId}`, this.token);
  }
}
