import * as fs from "node:fs";

/**
 * Remove a fixture directory, retrying a few times.
 *
 * Windows intermittently holds a handle on freshly written git object files
 * in %TEMP% (antivirus/indexer), which surfaces as EPERM on the first rmSync.
 * Teardown failures here leak only an OS temp dir, so after the retries give
 * up we warn rather than fail the suite.
 */
export function removeTree(dir: string, attempts = 5, delayMs = 200): void {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const until = Date.now() + delayMs * (i + 1);
      while (Date.now() < until) {
        /* brief synchronous backoff; teardown is not hot */
      }
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`teardown: leaving temp dir ${dir} (${String(e)})`);
  }
}
