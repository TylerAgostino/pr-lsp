// Pure mapping of GitHub review comments to current buffer lines.
// No I/O — unit-testable with hand-built fixtures.

export interface AnchorResult {
  state: "line";
  /** 0-based buffer line. */
  line: number;
}

export interface StaleResult {
  state: "stale";
}

export type Anchor = AnchorResult | StaleResult;

export interface AnchorInput {
  /** GitHub's current RIGHT-side line (1-based), null when file/line removed. */
  line: number | null;
  original_line: number | null;
  /** 1-based index within diff_hunk including the @@ header. */
  position: number | null;
  diff_hunk: string;
  commit_id: string;
}

interface HunkEntry {
  /** Content of this line as it appears on the RIGHT (new) side; null for deletions. */
  newContent: string | null;
  isContext: boolean;
  /** 1-based running index over raw hunk lines (matching GitHub `position`). */
  rawIndex: number;
}

/** Parse a diff_hunk into raw entries; returns [] for empty/malformed hunks. */
function parseHunk(hunk: string): HunkEntry[] {
  const raw = hunk.split("\n");
  const entries: HunkEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i];
    if (line.startsWith("@@")) {
      entries.push({ newContent: null, isContext: false, rawIndex: i + 1 });
      continue;
    }
    const marker = line[0];
    if (marker === "+") entries.push({ newContent: line.slice(1), isContext: false, rawIndex: i + 1 });
    else if (marker === "-") entries.push({ newContent: null, isContext: false, rawIndex: i + 1 });
    else entries.push({ newContent: line.slice(1), isContext: true, rawIndex: i + 1 });
  }
  return entries;
}

/**
 * Right-side (new file) line ranges covered by the `@@` headers of a
 * unified diff/patch. A comment posted to GitHub must land inside one of
 * these ranges (or on an added line), otherwise the API answers
 * `422: Path could not be resolved`.
 */
export function hunkRanges(diff: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const line of diff.split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue;
    out.push({ start, end: start + count - 1 });
  }
  return out;
}

const eq = (a: string, b: string): boolean => a.trim() === b.trim();

/**
 * Anchor a comment into `lines` (current buffer content).
 * 1. If the comment tracks the current head and the buffer is not dirty,
 *    GitHub's `line` is authoritative.
 * 2. Otherwise context-match around the hunk line the comment points at.
 * 3. No match -> stale.
 */
export function anchorToBuffer(
  lines: string[],
  comment: AnchorInput,
  headSha: string,
  bufferDirty: boolean,
): Anchor {
  if (
    !bufferDirty &&
    comment.commit_id === headSha &&
    comment.line !== null &&
    comment.line >= 1 &&
    comment.line <= lines.length
  ) {
    return { state: "line", line: comment.line - 1 };
  }
  const viaContext = contextAnchor(lines, comment);
  if (viaContext) return viaContext;
  return { state: "stale" };
}

function contextAnchor(lines: string[], comment: AnchorInput): Anchor | null {
  const entries = parseHunk(comment.diff_hunk);
  if (entries.length === 0) return null;
  // Locate the hunk entry GitHub's `position` points at (fall back to the
  // entry nearest original_line when position is missing).
  let targetIdx = -1;
  if (comment.position !== null) {
    targetIdx = entries.findIndex((e) => e.rawIndex === comment.position);
  }
  if (targetIdx === -1) {
    // No usable position: without the exact hunk line the context window is
    // undefined; only trust a still-in-range GitHub line (caller handles it).
    return null;
  }
  const target = entries[targetIdx];
  if (target.newContent === null) return null; // deleted line: no RIGHT anchor

  // New-side window around the target.
  const pre: string[] = [];
  for (let i = targetIdx - 1; i >= 0 && pre.length < 3; i -= 1) {
    if (!entries[i].isContext) break;
    pre.unshift(entries[i].newContent as string);
  }
  const post: string[] = [];
  for (let i = targetIdx + 1; i < entries.length && post.length < 3; i += 1) {
    if (!entries[i].isContext) break;
    post.push(entries[i].newContent as string);
  }

  // Find buffer occurrences of the target content; validate windows.
  let best: { line: number; score: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!eq(lines[i], target.newContent)) continue;
    let score = 1;
    let preOk = true;
    for (let k = 0; k < pre.length; k += 1) {
      const j = i - (pre.length - k);
      if (j < 0 || !eq(lines[j], pre[k])) preOk = false;
    }
    if (preOk) score += pre.length;
    else if (pre.length > 0) continue; // pre-window required when present
    let postOk = true;
    for (let k = 0; k < post.length; k += 1) {
      const j = i + 1 + k;
      if (j >= lines.length || !eq(lines[j], post[k])) postOk = false;
    }
    if (postOk) score += post.length;
    if (best === null || score > best.score) best = { line: i, score };
    else if (score === best.score && i < best.line) best.line = i;
  }
  if (best === null) return null;
  return { state: "line", line: best.line };
}
