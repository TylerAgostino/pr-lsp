import * as fs from "node:fs";

/**
 * Remove a fixture directory.
 *
 * Windows intermittently holds a handle on freshly written git object files
 * in %TEMP% (antivirus/indexer), which surfaces as EPERM on the first remove.
 * Node's built-in retry options absorb that; a failure after the retries is
 * real (e.g. a leaked server process or open handle), so it propagates and
 * fails the suite.
 */
export function removeTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
