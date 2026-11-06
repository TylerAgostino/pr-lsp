import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CMD_CREATE_COMMENT_DRAFT,
  CMD_DRAFT_REVIEW,
  CMD_REACT,
  CMD_RESOLVE_THREAD,
} from "../src/commands";
import { TestClient } from "./client";
import { emptyState, startFakeGithub, type FakeGithub } from "./fake-github";
import { makeFixtureRepo } from "./fixtures/repo";

let fake: FakeGithub;
let client: TestClient;
let dir: string;
let headSha: string;
let filePath: string;
let uri: string;
const draftsDir = (): string => path.join(dir, ".git", "pr-review");

function seedComment(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    body: "body",
    path: "src/foo.ts",
    line: 1,
    original_line: 1,
    position: null,
    diff_hunk: "",
    commit_id: headSha,
    user: { login: "reviewer" },
    created_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/testowner/testrepo/pull/42#discussion_r1",
    pull_request_url: "https://api.github.com/repos/testowner/testrepo/pulls/42",
    reactions: { total_count: 0 },
    ...over,
  };
}

beforeAll(async () => {
  fake = await startFakeGithub(emptyState());
  const repo = await makeFixtureRepo();
  dir = repo.dir;
  headSha = repo.headSha;
  filePath = repo.filePath;
  uri = `file:///${filePath.replace(/\\/g, "/")}`;
  fake.state.prs.push({
    number: 42,
    title: "Add feature",
    html_url: "https://github.com/testowner/testrepo/pull/42",
    state: "open",
    head: { sha: headSha, ref: "feature/x" },
    updated_at: "2026-01-01T00:00:00Z",
  });
  fake.state.comments.push(
    seedComment({ id: 11, body: "rename this", line: 5, user: { login: "octocat" } }),
    seedComment({ id: 12, body: "agree", in_reply_to_id: 11, line: 5, user: { login: "author" } }),
    seedComment({ id: 13, body: "explain line 20", line: 20 }),
  );
  fake.state.threads.push({ id: "PT_ext11", isResolved: false, commentIds: [11, 12] });
  process.env.GITHUB_TOKEN = "faketoken";
  client = new TestClient(dir);
  await client.initialize({ githubBaseUrl: fake.url });
});

afterAll(async () => {
  await client.shutdown();
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.GITHUB_TOKEN;
});

function onlyDraft(prefix: string): string {
  const names = fs.readdirSync(draftsDir()).filter((n) => n.startsWith(prefix));
  expect(names.length).toBe(1);
  return path.join(draftsDir(), names[0]);
}

function rewriteBody(draftFile: string, body: string): void {
  const text = fs.readFileSync(draftFile, "utf8");
  const idx = text.indexOf("---", 3);
  fs.writeFileSync(draftFile, `${text.slice(0, idx + 3)}\n\n${body}\n`);
}

async function waitUntil(fn: () => boolean, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("waitUntil: condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("code actions and drafts", () => {
  it("opens with two threads anchored", async () => {
    client.openDoc(filePath, fs.readFileSync(filePath, "utf8"));
    const list = await client.waitForDiagnostics(uri, 15_000);
    expect(list.length).toBe(2);
  });

  it("offers react/reply/resolve/view on a commented line", async () => {
    const acts = (await client.codeActions(filePath, {
      start: { line: 4, character: 0 },
      end: { line: 4, character: 0 },
    })) as { title: string; command?: { command: string; arguments?: unknown[] } }[];
    const titles = acts.map((a) => a.title);
    expect(titles).toContain("React 👍");
    expect(titles).toContain("Reply to @octocat…");
    expect(titles).toContain("Resolve thread");
    expect(titles).toContain("View on GitHub");
    const react = acts.find((a) => a.title === "React 👍");
    expect(react!.command!.command).toBe(CMD_REACT);
    expect(react!.command!.arguments).toEqual([11, "+1"]);
  });

  it("offers comment draft on a plain line with cursor or selection", async () => {
    const plain = (await client.codeActions(filePath, {
      start: { line: 30, character: 0 },
      end: { line: 30, character: 0 },
    })) as { title: string; command?: { command: string; arguments?: unknown[] } }[];
    expect(plain.map((a) => a.title)).toEqual(["Add PR review comment…"]);
    expect(plain[0]!.command!.arguments).toEqual([uri, 31]);
    const sel = (await client.codeActions(filePath, {
      start: { line: 2, character: 0 },
      end: { line: 5, character: 10 },
    })) as { title: string }[];
    expect(sel.map((a) => a.title)).toContain("Add PR review comment…");
  });

  it("react posts to GitHub and updates counters", async () => {
    await client.execCommand(CMD_REACT, [11, "+1"]);
    expect(fake.postsMatching(/pulls\/comments\/11\/reactions$/).length).toBe(1);
    const c = fake.state.comments.find((cc) => cc.id === 11);
    expect((c!.reactions as Record<string, unknown>)["+1"]).toBe(1);
  });

  it("resolve thread flips GraphQL state", async () => {
    await client.execCommand(CMD_RESOLVE_THREAD, ["PT_ext11", true]);
    expect(fake.state.threads[0].isResolved).toBe(true);
  });

  it(
    "reply draft round-trips: file -> edit -> save -> posted, deleted, republished",
    async () => {
    await client.execCommand(CMD_CREATE_COMMENT_DRAFT, [uri, 5, 11]);
    const draft = onlyDraft("reply-11-");
    expect(fs.readFileSync(draft, "utf8")).toContain("comment: 11");
    rewriteBody(draft, "thanks both");
    const draftUri = `file:///${draft.replace(/\\/g, "/")}`;
      client.openDoc(draft, fs.readFileSync(draft, "utf8"));
      const republished = client.waitForNotification(
        "textDocument/publishDiagnostics",
        (p) => {
          const d = p as { uri: string; diagnostics: { message?: string }[] };
          return d.uri === uri && d.diagnostics.some((m) => String(m.message).includes("(replies: 2)"));
        },
        15_000,
      );
      client.saveDoc(draft);
      try {
        await republished;
      } catch (e) {
        throw new Error(
          `${String(e)} | fake requests: ${JSON.stringify(fake.requests.map((r) => `${r.method} ${r.path}`))}`,
        );
      }
      const posted = fake.state.comments.find((c) => c.body === "thanks both");
      expect(posted).toBeTruthy();
      expect(posted!.in_reply_to_id).toBe(11);
      expect(fs.existsSync(draft)).toBe(false);
    },
    30_000,
  );

  it(
    "comment draft posts on its saved line",
    async () => {
      await client.execCommand(CMD_CREATE_COMMENT_DRAFT, [uri, 25]);
      const draft = onlyDraft("comment-25-");
    rewriteBody(draft, "why line 25?");
    client.openDoc(draft, fs.readFileSync(draft, "utf8"));
    client.saveDoc(draft);
    await waitUntil(() => fake.state.comments.some((c) => c.body === "why line 25?"));
    const posted = fake.state.comments.find((c) => c.body === "why line 25?");
    expect(posted).toBeTruthy();
    expect(posted!.line).toBe(25);
    expect(posted!.path).toBe("src/foo.ts");
      expect(fs.existsSync(draft)).toBe(false);
    },
    30_000,
  );

  it("review draft submits the parsed event", async () => {
    await client.execCommand(CMD_DRAFT_REVIEW, []);
    const draft = onlyDraft("review-");
    const text = fs.readFileSync(draft, "utf8");
    expect(text).toContain("event: comment");
    fs.writeFileSync(
      draft,
      text.replace("event: comment", "event: approve").replace("Write the review summary, then save.", "ship it"),
    );
    client.openDoc(draft, fs.readFileSync(draft, "utf8"));
    client.saveDoc(draft);
    await waitUntil(() => fake.state.reviews.some((r) => r.event === "APPROVE"));
    const posted = fake.state.reviews.find((r) => r.event === "APPROVE");
    expect(posted).toBeTruthy();
    expect(fs.existsSync(draft)).toBe(false);
  });
});
