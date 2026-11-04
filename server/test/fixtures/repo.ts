// Creates a throwaway git repo (branch feature/x, origin github.com/testowner/testrepo)
// for integration tests. Content of src/foo.ts is deterministic so tests can
// build diff_hunks against it.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

export const FIXTURE_REL_PATH = "src/foo.ts";

/** Deterministic 40-line file content; line N is `line N: ...`. */
export function fixtureLines(): string[] {
  return Array.from({ length: 40 }, (_, i) => `line ${i + 1}: value_${i + 1} = ${i + 1};`);
}

export function fixtureContent(): string {
  return fixtureLines().join("\n") + "\n";
}

export interface FixtureRepo {
  dir: string;
  filePath: string;
  branch: string;
  headSha: string;
}

export async function makeFixtureRepo(): Promise<FixtureRepo> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prl-repo-"));
  await git(dir, "init", "-b", "feature/x");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test User");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  const filePath = path.join(dir, FIXTURE_REL_PATH);
  writeFileSync(filePath, fixtureContent());
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "init");
  await git(dir, "remote", "add", "origin", "git@github.com:testowner/testrepo.git");
  const headSha = await git(dir, "rev-parse", "HEAD");
  return { dir, filePath, branch: "feature/x", headSha };
}
