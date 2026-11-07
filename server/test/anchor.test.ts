import { describe, expect, it } from "vitest";
import { anchorToBuffer, hunkRanges } from "../src/anchor";
import { fixtureLines } from "./fixtures/repo";

const HEAD = "aaaa";
const base = fixtureLines();

describe("anchorToBuffer", () => {
  it("uses GitHub line directly when comment tracks head and buffer is clean", () => {
    const a = anchorToBuffer(
      base,
      { line: 10, original_line: 10, position: null, diff_hunk: "", commit_id: HEAD },
      HEAD,
      false,
    );
    expect(a).toEqual({ state: "line", line: 9 });
  });

  it("re-anchors by diff_hunk context when the buffer shifted", () => {
    const shifted = [...base.slice(0, 3), "extra a", "extra b", "extra c", ...base.slice(3)];
    // comment on context line 20 inside a hunk that changed line 21
    const hunk = [
      "@@ -18,5 +18,5 @@",
      ` ${base[17]}`,
      ` ${base[18]}`,
      ` ${base[19]}`,
      `-${base[20]}`,
      `+${base[20]} // fixed`,
    ].join("\n");
    const a = anchorToBuffer(
      shifted,
      { line: 20, original_line: 20, position: 4, diff_hunk: hunk, commit_id: "old-sha" },
      HEAD,
      false,
    );
    expect(a).toEqual({ state: "line", line: 22 }); // 3 inserted lines above
  });

  it("marks stale when hunk context cannot be found", () => {
    const edited = [...base];
    edited[19] = "this line was rewritten entirely";
    const hunk = [
      "@@ -18,4 +18,4 @@",
      ` ${base[17]}`,
      ` ${base[18]}`,
      ` ${base[19]}`,
      `-${base[20]}`,
    ].join("\n");
    const a = anchorToBuffer(
      edited,
      { line: 20, original_line: 20, position: 4, diff_hunk: hunk, commit_id: "old-sha" },
      HEAD,
      false,
    );
    expect(a).toEqual({ state: "stale" });
  });

  it("falls back to context matching when buffer is dirty", () => {
    const dirtyShifted = ["inserted", ...base];
    const hunk = [
      "@@ -19,4 +19,4 @@",
      ` ${base[18]}`,
      ` ${base[19]}`,
      ` ${base[20]}`,
      `-${base[21]}`,
    ].join("\n");
    const a = anchorToBuffer(
      dirtyShifted,
      { line: 20, original_line: 20, position: 3, diff_hunk: hunk, commit_id: HEAD },
      HEAD,
      true,
    );
    expect(a).toEqual({ state: "line", line: 20 }); // base[19] now at index 20
  });
});

describe("hunkRanges", () => {
  it("maps @@ headers to right-side ranges (multi-hunk, omitted counts, CRLF)", () => {
    const diff = [
      "@@ -1,0 +1,3 @@",
      " a",
      " b",
      " c",
      "@@ -40 +41,2 @@ fn",
      " d",
      " e",
      "@@ -9 +10,0 @@",
    ].join("\r\n");
    expect(hunkRanges(diff)).toEqual([
      { start: 1, end: 3 },
      { start: 41, end: 42 },
    ]);
  });
});
