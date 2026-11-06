import { removeTree } from "./fixtures/rmtree";
import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestClient } from "./client";
import { emptyState, startFakeGithub, type FakeGithub } from "./fake-github";
import { fixtureLines, makeFixtureRepo } from "./fixtures/repo";

let fake: FakeGithub;
let client: TestClient;
let dir: string;
let headSha: string;
let filePath: string;
let uri: string;

function client_uri(p: string): string {
  return `file:///${p.replace(/\\/g, "/")}`;
}

beforeAll(async () => {
  fake = await startFakeGithub(emptyState());
  const repo = await makeFixtureRepo();
  dir = repo.dir;
  headSha = repo.headSha;
  filePath = repo.filePath;
  uri = client_uri(filePath);

  const seedComment = (over: Record<string, unknown>): Record<string, unknown> => ({
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
    reactions: { total_count: 0, "+1": 0 },
    ...over,
  });
  fake.state.prs.push({
    number: 42,
    title: "Add feature",
    html_url: "https://github.com/testowner/testrepo/pull/42",
    state: "open",
    head: { sha: headSha, ref: "feature/x" },
    updated_at: "2026-01-01T00:00:00Z",
  });
  fake.state.comments.push(
    seedComment({
      id: 11,
      body: "rename this\nsecond paragraph",
      line: 5,
      user: { login: "octocat" },
      reactions: { total_count: 1, heart: 1 },
    }),
    seedComment({ id: 12, body: "agree", in_reply_to_id: 11, line: 5, user: { login: "author" } }),
    seedComment({
      id: 13,
      body: "explain line 20",
      line: 20,
      original_line: 20,
      position: 4,
      commit_id: "old-sha",
      diff_hunk: [
        "@@ -18,5 +18,5 @@",
        ` ${fixtureLines()[17]}`,
        ` ${fixtureLines()[18]}`,
        ` ${fixtureLines()[19]}`,
        `-${fixtureLines()[20]}`,
        `+${fixtureLines()[20]} fixed`,
      ].join("\n"),
    }),
  );

  process.env.GITHUB_TOKEN = "faketoken";
  client = new TestClient(dir);
  await client.initialize({ githubBaseUrl: fake.url });
});

afterAll(async () => {
  await client.shutdown();
  await fake.close();
  removeTree(dir);
  delete process.env.GITHUB_TOKEN;
});

describe("buffer annotations", () => {
  it("publishes one diagnostic per thread, replies grouped", async () => {
    const text = fs.readFileSync(filePath, "utf8");
    client.openDoc(filePath, text);
    const list = await client.waitForDiagnostics(uri, 15_000);
    expect(list.length).toBe(2);
    const a = list.find((d) => (d.data as { commentId: number }).commentId === 11);
    const c = list.find((d) => (d.data as { commentId: number }).commentId === 13);
    expect(a).toBeTruthy();
    expect(c).toBeTruthy();
    expect(a!.range.start.line).toBe(4);
    expect(c!.range.start.line).toBe(19);
    expect(a!.severity).toBe(3); // Information
    expect(a!.source).toBe("PR Review");
    expect(String(a!.message)).toContain("@octocat: rename this");
    expect(String(a!.message)).toContain("(replies: 1)");
    expect(String(c!.message)).toContain("@reviewer: explain line 20");
  });

  it("hover on a commented line returns the thread card; elsewhere null", async () => {
    const hit = (await client.hover(filePath, 4)) as { contents: { value: string } } | null;
    expect(hit).not.toBeNull();
    const value = String(hit!.contents.value);
    expect(value).toContain("@octocat");
    expect(value).toContain("rename this");
    expect(value).toContain("second paragraph");
    expect(value).toContain("❤️1");
    expect(value).toContain("View on GitHub");

    const miss = await client.hover(filePath, 30);
    expect(miss).toBeNull();
  });

  it("inlay hints badge commented lines", async () => {
    const hs = (await client.inlayHints(filePath)) as { label: string; position: { line: number } }[];
    expect(hs.length).toBe(2);
    expect(hs[0].position.line).toBe(4);
    expect(hs[0].label).toContain("PR 42");
    expect(hs[0].label).toContain("1 comment");
  });
});
