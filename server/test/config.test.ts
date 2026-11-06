import { describe, expect, it } from "vitest";
import { configFromSettings, DEFAULT_CONFIG, sanitizeDraftsDir } from "../src/config";

describe("sanitizeDraftsDir", () => {
  it("rejects drafts inside .git — saves never route from there", () => {
    expect(sanitizeDraftsDir(".git/pr-review")).toBe(".pr-review");
    expect(sanitizeDraftsDir(".git")).toBe(".pr-review");
    expect(sanitizeDraftsDir(".git\\drafts")).toBe(".pr-review");
    expect(sanitizeDraftsDir("./.git/x")).toBe(".pr-review");
    expect(sanitizeDraftsDir(".git/pr-review/")).toBe(".pr-review");
  });

  it("leaves worktree-visible values untouched", () => {
    expect(sanitizeDraftsDir("drafts")).toBe("drafts");
    expect(sanitizeDraftsDir(".pr-review")).toBe(".pr-review");
    expect(sanitizeDraftsDir("x/.git")).toBe("x/.git");
  });

  it("configFromSettings applies the correction", () => {
    expect(configFromSettings({ draftsDir: ".git/pr-review" }).draftsDir).toBe(".pr-review");
    expect(configFromSettings({}).draftsDir).toBe(DEFAULT_CONFIG.draftsDir);
  });
});
