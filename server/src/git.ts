import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface GitHubRemote {
  host: string;
  owner: string;
  repo: string;
}

export interface RepoInfo {
  root: string;
  /** Branch name, or "HEAD" when detached. */
  branch: string;
  headSha: string;
  remote: GitHubRemote | null;
}

/** Run `git <args>` in `cwd`; resolves trimmed stdout, rejects on failure. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

/**
 * Parse a git remote URL into GitHub host/owner/repo.
 * Accepts scp-like (`git@host:owner/repo.git`), `ssh://git@host/o/r`,
 * and `https://host/owner/repo` forms. Returns null otherwise.
 */
export function parseGitHubRemote(url: string): GitHubRemote | null {
  const cleaned = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const https = /^https?:\/\/(?:[^/@]+@)?([^/]+)\/(.+)$/.exec(cleaned);
  const ssh = /^(?:ssh:\/\/(?:[^/@]+@)?|([^/@]+)@)([^/:]+)[:/](.+)$/.exec(cleaned);
  let host: string;
  let rest: string;
  if (https) {
    host = https[1];
    rest = https[2];
  } else if (ssh) {
    host = ssh[2];
    rest = ssh[3];
  } else {
    return null;
  }
  const segs = rest.split("/").filter((s) => s.length > 0);
  if (segs.length < 2) return null;
  const repo = segs[segs.length - 1];
  const owner = segs[segs.length - 2];
  return { host, owner, repo };
}

/**
 * Resolve the git context for a workspace root. Returns null when the
 * directory is not a git repository (a missing/foreign origin yields
 * `remote: null`, not a failure).
 */
export async function resolveRepo(root: string): Promise<RepoInfo | null> {
  let top: string;
  try {
    top = await git(root, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
  try {
    const branch = await git(top, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const headSha = await git(top, ["rev-parse", "HEAD"]);
    let remote: GitHubRemote | null = null;
    try {
      const url = await git(top, ["remote", "get-url", "origin"]);
      remote = parseGitHubRemote(url);
    } catch {
      remote = null;
    }
    return { root: top, branch, headSha, remote };
  } catch {
    return null;
  }
}
