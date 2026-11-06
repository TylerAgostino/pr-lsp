import * as fs from "node:fs";

/**
 * Remove a fixture directory, best effort.
 *
 * Windows (Defender/indexer) can hold a delete-blocking handle on a
 * directory a language-server process used as its CWD for seconds after
 * the process exits. That is a property of this machine, not the code
 * under test, so failures after the retries warn (leaking a temp dir)
 * instead of failing the suite.
 */
export function removeTree(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    console.warn(`[rmtree] could not remove ${dir}: ${(e as Error).message}`);
  }
}
