import { mkdtempSync } from "node:fs";
import { removeTree } from "./fixtures/rmtree";
import * as os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { resolveToken } from "../src/auth";
import { parseGitHubRemote, resolveRepo } from "../src/git";
import { GithubClient, parseReviewComment } from "../src/github";
import type { EffectiveConfig } from "../src/config";
import { emptyState, startFakeGithub, type FakeGithub } from "./fake-github";
import { makeFixtureRepo, type FixtureRepo } from "./fixtures/repo";

function cfgWith(baseUrl: string): EffectiveConfig {
  return { githubBaseUrl: baseUrl, inlayHints: true, draftsDir: ".pr-review", pollIntervalMs: 30_000 };
}

function seedComment(opts: {
  id: number;
  pr: number;
  path: string;
  line: number;
  body: string;
  login: string;
  commitId: string;
}) {
  return {
    id: opts.id,
    body: opts.body,
    path: opts.path,
    line: opts.line,
    original_line: opts.line,
    side: "RIGHT",
    diff_hunk: `@@ -0,0 +${opts.line},1 @@\n+${opts.body.slice(0, 20)}`,
    user: { login: opts.login },
    created_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/testowner/testrepo/pull/${opts.pr}#discussion_r${opts.id}`,
    pull_request_url: `/repos/testowner/testrepo/pulls/${opts.pr}`,
    commit_id: opts.commitId,
    in_reply_to_id: null,
    reactions: { total_count: 0 },
  };
}

describe("parseGitHubRemote", () => {
  it("parses scp-like, ssh:// and https:// remotes", () => {
    expect(parseGitHubRemote("git@github.com:testowner/testrepo.git")).toEqual({
      host: "github.com",
      owner: "testowner",
      repo: "testrepo",
    });
    expect(parseGitHubRemote("https://github.com/testowner/testrepo")).toEqual({
      host: "github.com",
      owner: "testowner",
      repo: "testrepo",
    });
    expect(parseGitHubRemote("ssh://git@ghe.acme.com/team/app.git")).toEqual({
      host: "ghe.acme.com",
      owner: "team",
      repo: "app",
    });
    expect(parseGitHubRemote("file:///tmp/whatever")).toBeNull();
  });
});

describe("resolveToken", () => {
  it("GITHUB_TOKEN wins over GH_TOKEN; empty means absent", () => {
    expect(resolveToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" })).toBe("a");
    expect(resolveToken({ GH_TOKEN: " b " })).toBe("b");
    expect(resolveToken({ GITHUB_TOKEN: "", GH_TOKEN: "" })).toBeNull();
    expect(resolveToken({})).toBeNull();
  });
});

describe("git + github integration", () => {
  let repo: FixtureRepo | null = null;
  let fake: FakeGithub | null = null;

  afterEach(async () => {
    if (fake) {
      await fake.close();
      fake = null;
    }
    if (repo) {
      removeTree(repo.dir);
      repo = null;
    }
  });

  it("resolves repo context and PR data through the fake API", async () => {
    repo = await makeFixtureRepo();

    const info = await resolveRepo(repo.dir);
    expect(info).not.toBeNull();
    expect(info!.branch).toBe("feature/x");
    expect(info!.remote).toEqual({ host: "github.com", owner: "testowner", repo: "testrepo" });

    const state = emptyState();
    state.prs.push({
      number: 42,
      title: "Add feature x",
      html_url: "https://github.com/testowner/testrepo/pull/42",
      state: "open",
      head: { sha: repo.headSha, ref: "feature/x" },
      updated_at: "2026-01-02T00:00:00Z",
    });
    state.comments.push(
      seedComment({ id: 11, pr: 42, path: "src/foo.ts", line: 5, body: "rename this", login: "reviewer", commitId: repo.headSha }),
      seedComment({ id: 12, pr: 42, path: "src/foo.ts", line: 20, body: "dead code?", login: "boss", commitId: repo.headSha }),
    );
    fake = await startFakeGithub(state);

    const client = new GithubClient(cfgWith(fake.url), "fake-token");
    const pr = await client.getOpenPrForBranch("testowner", "testrepo", "feature/x");
    expect(pr).not.toBeNull();
    expect(pr!.number).toBe(42);

    const none = await client.getOpenPrForBranch("testowner", "testrepo", "other-branch");
    expect(none).toBeNull();

    const comments = await client.listReviewComments("testowner", "testrepo", 42);
    expect(comments.map((c) => [c.id, c.line, c.user?.login])).toEqual([
      [11, 5, "reviewer"],
      [12, 20, "boss"],
    ]);

    // mutation endpoints hit the recorder
    await client.addReaction("testowner", "testrepo", 11, "+1");
    expect(fake.postsMatching(/pulls\/comments\/11\/reactions$/)).toHaveLength(1);
    await client.replyToComment("testowner", "testrepo", 42, 11, "done");
    expect(fake.postsMatching(/pulls\/42\/comments\/11\/replies$/)).toHaveLength(1);
    await client.submitReview("testowner", "testrepo", 42, "APPROVE", "lgtm");
    expect(fake.state.reviews.some((r) => r.event === "APPROVE")).toBe(true);

    // graphql threads
    fake.state.threads.push({ id: "PRRT_abc", isResolved: false, commentIds: [11, 21] });
    const threads = await client.getThreads("testowner", "testrepo", 42);
    expect(threads.get(11)?.threadId).toBe("PRRT_abc");
    const nowResolved = await client.setThreadResolved("testowner", "testrepo", "PRRT_abc", true);
    expect(nowResolved).toBe(true);
    expect(fake.state.threads[0].isResolved).toBe(true);
    const nowUnresolved = await client.setThreadResolved("testowner", "testrepo", "PRRT_abc", false);
    expect(nowUnresolved).toBe(true);
    expect(fake.state.threads[0].isResolved).toBe(false);

    expect(parseReviewComment({})).toBeNull();
  });
  it("falls back to a COMMENT review when the direct endpoint 422s", async () => {
    const state = emptyState();
    state.rejectDirectComments = true;
    fake = await startFakeGithub(state);

    const client = new GithubClient(cfgWith(fake.url), "fake-token");
    await client.createReviewComment("testowner", "testrepo", 42, "why 2?", "src/bar.ts", 6);

    const fallbacks = fake.postsMatching(/pulls\/42\/reviews$/);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].body).toMatchObject({
      event: "COMMENT",
      comments: [{ path: "src/bar.ts", line: 6, side: "RIGHT", body: "why 2?" }],
    });
    // ...and the rejected-direct path never happened except the 422'd attempt
    expect(fake.postsMatching(/pulls\/42\/comments$/)).toHaveLength(1);
    expect(fake.state.comments).toHaveLength(1);
    expect(fake.state.comments[0]).toMatchObject({ path: "src/bar.ts", line: 6, body: "why 2?" });
  });

  it("lists, removes own reactions, and deletes comments", async () => {
    const state = emptyState();
    state.comments.push(
      seedComment({ id: 31, pr: 42, path: "src/foo.ts", line: 5, body: "mine", login: "testuser", commitId: "sha" }),
    );
    fake = await startFakeGithub(state);
    const client = new GithubClient(cfgWith(fake.url), "fake-token");

    expect(await client.getCurrentUser()).toBe("testuser");

    await client.addReaction("testowner", "testrepo", 31, "+1");
    const rxs = await client.listReactions("testowner", "testrepo", 31);
    expect(rxs).toHaveLength(1);
    expect(rxs[0]).toMatchObject({ content: "+1", login: "testuser" });

    await client.deleteReaction("testowner", "testrepo", 31, rxs[0]!.id);
    expect(await client.listReactions("testowner", "testrepo", 31)).toHaveLength(0);

    await client.deleteReviewComment("testowner", "testrepo", 31);
    expect(fake.state.comments).toHaveLength(0);
  });

  it("returns null context for a non-git workspace", async () => {
    const other = mkdtempSync(`${os.tmpdir()}/prl-nogit-`);
    try {
      expect(await resolveRepo(other)).toBeNull();
    } finally {
      removeTree(other);
    }
  });
});
