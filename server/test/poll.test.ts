import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestClient } from "./client";
import { emptyState, startFakeGithub, type FakeGithub } from "./fake-github";
import { makeFixtureRepo } from "./fixtures/repo";

let fake: FakeGithub;
let client: TestClient;
let dir: string;
let headSha: string;
let filePath: string;
let uri: string;

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
    html_url: "https://github.com/testowner/testrepo/pull/1#discussion_r1",
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
  fake.state.comments.push(seedComment({ id: 11, body: "rename this", line: 5 }));
  process.env.GITHUB_TOKEN = "faketoken";
  client = new TestClient(dir);
  await client.initialize({ githubBaseUrl: fake.url, pollIntervalMs: 250 });
});

afterAll(async () => {
  await client.shutdown();
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.GITHUB_TOKEN;
});

function latestDiags(): string[] | null {
  let out: string[] | null = null;
  for (const n of client.notifications) {
    if (n.method !== "textDocument/publishDiagnostics") continue;
    const p = n.params as { uri: string; diagnostics: { message?: string }[] };
    if (p.uri === uri) out = p.diagnostics.map((d) => String(d.message));
  }
  return out;
}

function diagsWith(substring: string): boolean {
  return (latestDiags() ?? []).some((m) => m.includes(substring));
}

describe("background poll", () => {
  it("surfaces a comment that arrives after the initial publish", async () => {
    client.openDoc(filePath, fs.readFileSync(filePath, "utf8"));
    await client.waitForDiagnostics(uri, 15_000);
    expect(diagsWith("rename this")).toBe(true);
    fake.state.comments.push(seedComment({ id: 20, body: "poll-new comment", line: 12 }));
    await client.waitForNotification(
      "textDocument/publishDiagnostics",
      (p) => {
        const d = p as { uri: string; diagnostics: { message?: string }[] };
        return d.uri === uri && d.diagnostics.some((m) => String(m.message).includes("poll-new comment"));
      },
      10_000,
    );
    expect(diagsWith("poll-new comment")).toBe(true);
  });

  it("re-anchors to a different PR on branch switch", async () => {
    fake.state.prs.push({
      number: 43,
      title: "Other branch",
      html_url: "https://github.com/testowner/testrepo/pull/43",
      state: "open",
      head: { sha: headSha, ref: "feature/y" },
      updated_at: "2026-01-02T00:00:00Z",
    });
    fake.state.comments.push(
      seedComment({
        id: 21,
        body: "y-branch note",
        line: 8,
        pull_request_url: "https://api.github.com/repos/testowner/testrepo/pulls/43",
      }),
    );
    execFileSync("git", ["checkout", "-b", "feature/y"], { cwd: dir, stdio: "ignore" });
    await client.waitForNotification(
      "textDocument/publishDiagnostics",
      (p) => {
        const d = p as { uri: string; diagnostics: { message?: string }[] };
        return d.uri === uri && d.diagnostics.some((m) => String(m.message).includes("y-branch note"));
      },
      15_000,
    );
    expect(diagsWith("rename this")).toBe(false);
  }, 30_000);
});
