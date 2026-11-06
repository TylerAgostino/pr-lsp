import { removeTree } from "./fixtures/rmtree";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestClient } from "./client";
import { emptyState, startFakeGithub, type FakeGithub } from "./fake-github";
import { fixtureLines, makeFixtureRepo } from "./fixtures/repo";

let fake: FakeGithub;
let client: TestClient;
let dir: string;
let headSha: string;
let fooPath: string;
let fooUri: string;
let barPath: string;
let barUri: string;

function asUri(p: string): string {
  return p.replace(/\\/g, "/").startsWith("file:") ? p : `file:///${p.replace(/\\/g, "/")}`;
}

const BAR_LINES = ["alpha() {", "  return 1;", "}", "", "beta() {", "  return 2;", "}"];

beforeAll(async () => {
  fake = await startFakeGithub(emptyState());
  const repo = await makeFixtureRepo();
  dir = repo.dir;
  headSha = repo.headSha;
  fooPath = repo.filePath;
  fooUri = asUri(fooPath);
  barPath = path.join(dir, "src", "bar.ts");
  barUri = asUri(barPath);
  fs.writeFileSync(barPath, BAR_LINES.join("\n") + "\n");

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
    html_url: `https://github.com/testowner/testrepo/pull/42#discussion_r${String(over.id ?? 1)}`,
    pull_request_url: "https://api.github.com/repos/testowner/testrepo/pulls/42",
    reactions: { total_count: 0 },
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
    // foo.ts thread with one reply; hunk lets the CLOSED file anchor via context
    seedComment({
      id: 21,
      body: "foo body\nsecond paragraph",
      line: 7,
      original_line: 7,
      position: 3,
      user: { login: "octocat" },
      diff_hunk: [
        "@@ -6,3 +6,3 @@",
        ` ${fixtureLines()[5]}`,
        ` ${fixtureLines()[6]}`,
        ` ${fixtureLines()[7]}`,
      ].join("\n"),
    }),
    seedComment({ id: 22, body: "agree", path: "src/foo.ts", in_reply_to_id: 21, line: 7, user: { login: "author" } }),
    // bar.ts single comment, also closed, context-anchored
    seedComment({
      id: 23,
      body: "why 2?",
      path: "src/bar.ts",
      line: 6,
      original_line: 6,
      position: 3,
      user: { login: "hunter" },
      diff_hunk: ["@@ -5,3 +5,3 @@", " beta() {", "   return 2;", " }"].join("\n"),
    }),
    // comment on a file that no longer exists on disk → outdated everywhere
    seedComment({ id: 24, body: "gone file", path: "src/gone.ts", line: 3, original_line: 3, user: { login: "ghost" } }),
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

describe("cross-file visibility", () => {
  it("publishes diagnostics for files that are not open in the editor", async () => {
    const barDiags = await client.waitForDiagnostics(barUri);
    expect(barDiags).toHaveLength(1);
    expect(barDiags[0].message).toBe("@hunter: why 2?");
    expect(barDiags[0].source).toBe("PR Review");
    expect(barDiags[0].range).toEqual({
      start: { line: 5, character: 0 },
      end: { line: 5, character: BAR_LINES[5].length },
    });

    const fooDiags = await client.waitForDiagnostics(fooUri);
    expect(fooDiags).toHaveLength(1);
    expect(fooDiags[0].message).toBe("@octocat: foo body (replies: 1)");
  });

  it("opening a previously-closed annotated file never gets a trailing empty clear", async () => {
    const barPubs = () =>
      client.notifications.filter(
        (n) =>
          n.method === "textDocument/publishDiagnostics" &&
          (n.params as { uri?: string }).uri === barUri,
      );
    const beforeOpen = barPubs().length;
    client.openDoc(barPath, fs.readFileSync(barPath, "utf8"));
    await client.execCommand("pr-review.refresh");
    // Let the didOpen-triggered pass and the refresh pass both settle.
    await new Promise((r) => setTimeout(r, 800));
    const after = barPubs().slice(beforeOpen);
    expect(after.length).toBeGreaterThan(0);
    for (const n of after) {
      expect((n.params as { diagnostics: unknown[] }).diagnostics).toHaveLength(1);
    }
  });

  it("listComments writes an all-threads listing and opens it", async () => {
    await client.execCommand("pr-review.listComments");
    const showDoc = client.serverRequests.find(
      (r) => r.method === "window/showDocument" && String((r.params as { uri?: string }).uri ?? "").includes("listing-"),
    );
    expect(showDoc).toBeDefined();
    const listingPath = (new URL(String((showDoc!.params as { uri: string }).uri))).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    expect(fs.existsSync(listingPath)).toBe(true);
    const md = fs.readFileSync(listingPath, "utf8");

    expect(md).toContain("# PR #42 — Add feature");
    expect(md).toContain("https://github.com/testowner/testrepo/pull/42");
    expect(md).toContain("## src/bar.ts (1)");
    expect(md).toContain("**L6** @hunter: why 2?");
    expect(md).toContain("## src/foo.ts (1)");
    expect(md).toContain("**L7** @octocat: foo body (replies: 1)");
    expect(md).toContain("## src/gone.ts (1)");
    expect(md).toContain("_outdated_ @ghost: gone file");
    expect(md.match(/\[view\]\(https:\/\/github\.com/g)?.length).toBe(3);
  });

  it("saving a listing posts nothing", async () => {
    const posted = () => fake.postsMatching(/comments|reviews/).length;
    const before = posted();
    const listingPath = client
      .serverRequests.filter((r) => r.method === "window/showDocument")
      .map((r) => new URL(String((r.params as { uri: string }).uri)).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
      .find((p) => p.includes("listing-"))!;
    const text = fs.readFileSync(listingPath, "utf8");
    client.openDoc(listingPath, text);
    client.saveDoc(listingPath);
    await new Promise((r) => setTimeout(r, 300));
    expect(posted()).toBe(before);
    expect(fs.existsSync(listingPath)).toBe(true);
  });
});
