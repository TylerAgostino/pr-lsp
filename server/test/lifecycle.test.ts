import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestClient } from "./client";

describe("server lifecycle", () => {
  let dir: string;
  let client: TestClient | null = null;

  afterEach(async () => {
    if (client) {
      try {
        await client.shutdown();
      } catch {
        client.proc.kill();
      }
      client = null;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("boots, and publishes empty diagnostics for a non-git workspace", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "prl-lifecycle-"));
    const filePath = path.join(dir, "sample.ts");
    writeFileSync(filePath, "export const x = 1;\n");

    client = new TestClient(dir);
    await client.initialize();
    client.openDoc(filePath, "export const x = 1;\n");

    const diags = await client.waitForDiagnostics(
      new URL(`file:///${filePath.replace(/\\/g, "/")}`).href,
    );
    expect(diags).toEqual([]);
    expect(client.proc.exitCode, client.stderr.join("")).toBeNull();
  });
});
