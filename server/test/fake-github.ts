// In-memory fake of the GitHub REST/GraphQL endpoints used by
// src/github.ts. Every request (method+path+body) is recorded for assertions.
//
// NOTE: named .ts (not .mjs) so `tsc --noEmit` covers it; vitest imports TS.
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { isRecord } from "../src/boundary";

export interface FakePr {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  head: { sha: string; ref: string };
  updated_at: string;
}

export interface FakeThread {
  id: string;
  isResolved: boolean;
  commentIds: number[];
}

export interface FakeState {
  owner: string;
  repo: string;
  prs: FakePr[];
  /** When true, the reviewThreads GraphQL query returns an errors payload. */
  graphqlFails?: boolean;
  /** When true, POST /pulls/{n}/comments answers 422 (drift/fallback testing). */
  rejectDirectComments?: boolean;
  /** Individual reaction records (GET/DELETE /reactions, comment deletes). */
  reactions: { id: number; commentId: number; content: string; login: string }[];
  nextReactionId: number;
  /** When true, GET /user answers 500 (identity-lookup retry testing). */
  userFails?: boolean;
  comments: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  threads: FakeThread[];
  nextCommentId: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeGithub {
  url: string;
  state: FakeState;
  requests: RecordedRequest[];
  close(): Promise<void>;
  postsMatching(pattern: RegExp): RecordedRequest[];
}

export function emptyState(owner = "testowner", repo = "testrepo"): FakeState {
  return {
    owner,
    repo,
    prs: [],
    comments: [],
    reviews: [],
    threads: [],
    nextCommentId: 1000,
    reactions: [],
    nextReactionId: 900,
  };
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function commentPrOf(c: Record<string, unknown>): number {
  const url = typeof c.pull_request_url === "string" ? c.pull_request_url : "";
  const m = /\/pulls\/(\d+)$/.exec(url);
  return m ? Number(m[1]) : -1;
}

export async function startFakeGithub(state: FakeState): Promise<FakeGithub> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body: unknown = raw.length > 0 ? JSON.parse(raw) : undefined;
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = reqUrl.pathname;
    const method = req.method ?? "";
    requests.push({ method, path, body });

    const P = "/api/v3";
    const repoPrefix = `${P}/repos/${state.owner}/${state.repo}`;

    if (method === "GET" && path === `${P}/user`) {
      if (state.userFails) return json(res, 500, { message: "Fake: user lookup failed" });
      return json(res, 200, { login: "testuser" });
    }

    if (method === "GET" && path === `${repoPrefix}/pulls`) {
      const headFilter = reqUrl.searchParams.get("head");
      const branch = headFilter === null ? null : headFilter.slice(headFilter.indexOf(":") + 1);
      const out = state.prs.filter(
        (pr) => pr.state === "open" && (branch === null || pr.head.ref === branch),
      );
      return json(res, 200, out);
    }

    let mm = /^\/api\/v3\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments$/.exec(path);
    if (mm && method === "GET") {
      const n = Number(mm[1]);
      const page = Number(reqUrl.searchParams.get("page") ?? "1");
      const per = Number(reqUrl.searchParams.get("per_page") ?? "30");
      const mine = state.comments.filter((c) => commentPrOf(c) === n);
      const start = (page - 1) * per;
      return json(res, 200, mine.slice(start, start + per));
    }
    if (mm && method === "POST") {
      const n = Number(mm[1]);
      if (state.rejectDirectComments) {
        return json(res, 422, { message: "Fake: direct line-note endpoint rejected" });
      }
      const created: Record<string, unknown> = {
        ...(isRecord(body) ? body : {}),
        id: state.nextCommentId++,
        user: { login: "testuser" },
        html_url: `https://github.com/${state.owner}/${state.repo}/pull/${n}#discussion_new`,
        pull_request_url: `${repoPrefix}/pulls/${n}`,
        reactions: { total_count: 0 },
      };
      state.comments.push(created);
      return json(res, 201, created);
    }

    mm = /^\/api\/v3\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(path);
    if (mm && method === "POST") {
      const n = Number(mm[1]);
      const parentId = Number(mm[2]);
      const parent = state.comments.find((c) => c.id === parentId) ?? {};
      const created: Record<string, unknown> = {
        ...(isRecord(body) ? body : {}),
        id: state.nextCommentId++,
        in_reply_to_id: parentId,
        path: parent.path,
        line: parent.line,
        original_line: parent.original_line,
        commit_id: parent.commit_id,
        user: { login: "testuser" },
        html_url: `https://github.com/${state.owner}/${state.repo}/pull/${n}#discussion_new`,
        pull_request_url: `${repoPrefix}/pulls/${n}`,
        reactions: { total_count: 0 },
      };
      state.comments.push(created);
      return json(res, 201, created);
    }

    mm = /^\/api\/v3\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(path);
    if (mm && method === "POST") {
      const n = Number(mm[1]);
      // A COMMENT review may carry inline comments; they become review comments.
      const list = isRecord(body) && Array.isArray(body.comments) ? body.comments : [];
      for (const c of list) {
        if (isRecord(c)) state.comments.push({ ...c, id: state.nextCommentId++, pull_request_review_id: state.reviews.length + 1 });
      }
      const rec: Record<string, unknown> = {
        ...(isRecord(body) ? body : {}),
        id: state.reviews.length + 1,
        submitted_at: "2026-01-01T00:00:00Z",
      };
      state.reviews.push(rec);
      return json(res, 201, { ...rec, html_url: `https://github.com/${state.owner}/${state.repo}/pull/${n}#pullrequestreview` });
    }

    const summarizeReactions = (commentId: number): void => {
      const c = state.comments.find((cc) => cc.id === commentId);
      if (!c) return;
      const mine = state.reactions.filter((r) => r.commentId === commentId);
      const counts: Record<string, number> = { total_count: mine.length };
      for (const r of mine) counts[r.content] = (counts[r.content] ?? 0) + 1;
      c.reactions = counts;
    };

    mm = /^\/api\/v3\/repos\/[^/]+\/[^/]+\/pulls\/comments\/(\d+)\/reactions$/.exec(path);
    if (mm) {
      const id = Number(mm[1]);
      if (method === "POST") {
        const content = isRecord(body) && typeof body.content === "string" ? body.content : "?";
        const rec = { id: state.nextReactionId++, commentId: id, content, login: "testuser" };
        state.reactions.push(rec);
        summarizeReactions(id);
        return json(res, 201, { id: rec.id, content, user: { login: "testuser" } });
      }
      if (method === "GET") {
        return json(
          res,
          200,
          state.reactions
            .filter((r) => r.commentId === id)
            .map((r) => ({ id: r.id, content: r.content, user: { login: r.login } })),
        );
      }
    }

    mm = /^\/api\/v3\/repos\/[^/]+\/[^/]+\/pulls\/comments\/(\d+)\/reactions\/(\d+)$/.exec(path);
    if (mm && method === "DELETE") {
      const id = Number(mm[1]);
      const rxId = Number(mm[2]);
      state.reactions = state.reactions.filter((r) => r.id !== rxId);
      summarizeReactions(id);
      res.writeHead(204);
      return res.end();
    }

    mm = /^\/api\/v3\/repos\/[^/]+\/[^/]+\/pulls\/comments\/(\d+)$/.exec(path);
    if (mm && method === "DELETE") {
      const id = Number(mm[1]);
      state.comments = state.comments.filter((c) => c.id !== id);
      state.reactions = state.reactions.filter((r) => r.commentId !== id);
      for (const t of state.threads) t.commentIds = t.commentIds.filter((cid) => cid !== id);
      res.writeHead(204);
      return res.end();
    }

    if (method === "GET" && /^\/api\/v3\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs$/.test(path)) {
      return json(res, 200, { check_runs: [] });
    }

    if (method === "POST" && (path === `${P}/graphql` || path === "/api/graphql")) {
      const q = isRecord(body) && typeof body.query === "string" ? body.query : "";
      const vars = isRecord(body) && isRecord(body.variables) ? body.variables : {};
      if (q.includes("resolveReviewThread") || q.includes("unresolveReviewThread")) {
        const input = isRecord(vars.input) ? vars.input : {};
        const threadId = typeof input.threadId === "string" ? input.threadId : "";
        const doResolve = !q.includes("unresolveReviewThread");
        const thread = state.threads.find((t) => t.id === threadId);
        if (thread) thread.isResolved = doResolve;
        const key = doResolve ? "resolveReviewThread" : "unresolveReviewThread";
        return json(res, 200, {
          data: { [key]: { thread: { id: threadId, isResolved: thread ? thread.isResolved : doResolve } } },
        });
      }
      if (q.includes("reviewThreads") && state.graphqlFails) {
        return json(res, 200, { data: null, errors: [{ message: "Fake GraphQL failure" }] });
      }
      if (q.includes("reviewThreads")) {
        return json(res, 200, {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: state.threads.map((t) => ({
                    id: t.id,
                    isResolved: t.isResolved,
                    comments: { nodes: t.commentIds.map((id) => ({ databaseId: id })) },
                  })),
                },
              },
            },
          },
        });
      }
      return json(res, 400, { errors: [{ message: `unhandled query: ${q.slice(0, 80)}` }] });
    }

    json(res, 404, { message: `not found: ${method} ${path}` });
  });

  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => resolve());
  await promise;
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    requests,
    close(): Promise<void> {
      const done = Promise.withResolvers<void>();
      server.close(() => done.resolve());
      return done.promise;
    },
    postsMatching(pattern: RegExp): RecordedRequest[] {
      return requests.filter((r) => r.method === "POST" && pattern.test(r.path));
    },
  };
}
