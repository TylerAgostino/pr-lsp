import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRAFT_FILE_RE,
  draftSeedBody,
  isUneditedDraft,
  migrateLegacyDrafts,
  parseDraft,
} from "../src/drafts";

describe("draft filename regex", () => {
  it("matches writeDraft names but never listings", () => {
    expect(DRAFT_FILE_RE.test("comment-42-1730000000000.md")).toBe(true);
    expect(DRAFT_FILE_RE.test("reply-11-1730000000000.md")).toBe(true);
    expect(DRAFT_FILE_RE.test("review-1730000000000.md")).toBe(true);
    expect(DRAFT_FILE_RE.test("listing-12-1730000000000.md")).toBe(false);
    expect(DRAFT_FILE_RE.test("notes.md")).toBe(false);
  });
});

describe("isUneditedDraft", () => {
  it("detects the untouched comment seed body from meta alone", () => {
    const text = [
      "---",
      "type: comment",
      "pr: 7",
      "path: src/foo.ts",
      "line: 42",
      "---",
      "",
      draftSeedBody("comment", { path: "src/foo.ts", line: 42 }),
      "",
    ].join("\n");
    const parsed = parseDraft(text);
    expect(parsed).not.toBeNull();
    expect(isUneditedDraft(parsed!.meta, parsed!.body)).toBe(true);
    expect(isUneditedDraft(parsed!.meta, "actually finished thought")).toBe(false);
  });

  it("detects untouched reply and review seeds", () => {
    const reply = parseDraft(
      ["---", "type: reply", "pr: 7", "comment: 11", "---", "", draftSeedBody("reply", {}), ""].join("\n"),
    );
    expect(reply && isUneditedDraft(reply.meta, reply.body)).toBe(true);
    const review = parseDraft(
      ["---", "type: review", "pr: 7", "event: comment", "---", "", draftSeedBody("review", {}), ""].join("\n"),
    );
    expect(review && isUneditedDraft(review.meta, review.body)).toBe(true);
  });
});

describe("migrateLegacyDrafts", () => {
  it("creates the destination before renaming (regression: silent no-op otherwise)", () => {
    const root = mkdtempSync(`${tmpdir()}/prl-mig-`);
    const legacy = path.join(root, ".git", "pr-review");
    const target = path.join(root, ".pr-review"); // destination does NOT exist yet
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "comment-5-1.md"), "draft body");
    writeFileSync(path.join(legacy, "listing-1-2.md"), "listing");
    migrateLegacyDrafts(legacy, target);
    expect(readFileSync(path.join(target, "comment-5-1.md"), "utf8")).toBe("draft body");
    expect(existsSync(path.join(target, "listing-1-2.md"))).toBe(true);
    expect(existsSync(path.join(legacy, "comment-5-1.md"))).toBe(false);
  });

  it("is a silent no-op without a legacy directory", () => {
    const root = mkdtempSync(`${tmpdir()}/prl-mig2-`);
    migrateLegacyDrafts(path.join(root, ".git", "pr-review"), path.join(root, ".pr-review"));
    expect(existsSync(path.join(root, ".pr-review"))).toBe(false);
  });
});
