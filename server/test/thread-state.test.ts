import { removeTree } from "./fixtures/rmtree";
import * as fs from "node:fs";
import { CMD_REFRESH } from "../src/commands";
import { TestClient } from "./client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyState, startFakeGithub, type FakeGithub } from "./fake-github";
import { fixtureContent, makeFixtureRepo, type FixtureRepo } from "./fixtures/repo";

let fake: FakeGithub;
let client: TestClient;
let repo: FixtureRepo;
let uri: string;

beforeAll(async () => {
  fake = await startFakeGithub(emptyState());
  repo = await makeFixtureRepo();
  uri = `file:///${repo.filePath.replace(/\\/g, "/")}`;

  fake.state.prs.push({
    number: 42,
    title: "Add feature",
    html_url: "https://github.com/testowner/testrepo/pull/42",
    state: "open",
    head: { sha: repo.headSha, ref: "feature/x" },
    updated_at: "2026-01-01T00:00:00Z",
  });
  fake.state.comments.push({
    id: 11,
    node_id: "PRRC_11",
    body: "rename this",
    path: "src/foo.ts",
    line: 5,
    original_line: 5,
    position: null,
    diff_hunk: "",
    commit_id: repo.headSha,
    user: { login: "octocat" },
    created_at: "2026-01-01T00:00:00Z",
    html_url: "https://github.com/testowner/testrepo/pull/42#discussion_r11",
    pull_request_url: "https://api.github.com/repos/testowner/testrepo/pulls/42",
    reactions: { total_count: 0, "+1": 0 },
  });
  fake.state.threads.push({ id: "PT_11", isResolved: false, commentIds: [11] });
  // Thread state (GraphQL) fails from the start; REST comments must still show.
  fake.state.graphqlFails = true;

  process.env.GITHUB_TOKEN = "faketoken";
  client = new TestClient(repo.dir);
  await client.initialize({ githubBaseUrl: fake.url });
});

afterAll(async () => {
  await client.shutdown();
  await fake.close();
  removeTree(repo.dir);
  delete process.env.GITHUB_TOKEN;
});

describe("thread-state failure isolation", () => {
  it("publishes annotations even when GraphQL thread state fails", async () => {
    client.openDoc(repo.filePath, fixtureContent());
    const diags = await client.waitForDiagnostics(uri);
    expect(diags.length).toBe(1);
    const acts = (await client.codeActions(repo.filePath, {
      start: { line: 4, character: 0 },
      end: { line: 4, character: 0 },
    })) as { title: string }[];
    const titles = acts.map((a) => a.title);
    expect(titles).toContain("Reply to @octocat…");
    expect(titles).not.toContain("Resolve thread");
  });
  it("recovers resolve actions once GraphQL succeeds on a later refresh", async () => {
    fake.state.graphqlFails = false;
    await client.execCommand(CMD_REFRESH, []);
    await client.waitForDiagnostics(uri);
    const acts = (await client.codeActions(repo.filePath, {
      start: { line: 4, character: 0 },
      end: { line: 4, character: 0 },
    })) as { title: string }[];
    expect(acts.map((a) => a.title)).toContain("Resolve thread");
  });
});
