import { mkdtempSync, writeFileSync } from "node:fs";
import { removeTree } from "./fixtures/rmtree";
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
    if (dir) removeTree(dir);
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

  it("logs a warning when draftsDir points inside .git/", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "prl-draftsdir-"));
    client = new TestClient(dir);
    const warned = client.waitForNotification(
      "window/logMessage",
      (p) =>
        typeof p === "object" && p !== null && "message" in p && String(p.message).includes("inside .git/"),
    );
    await client.initialize({ draftsDir: ".git/pr-review" });
    const params = await warned;
    expect(params && typeof params === "object" && "message" in params ? String(params.message) : "").toContain(
      'using ".pr-review" instead',
    );
  });
});
