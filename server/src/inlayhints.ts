import { InlayHintKind, type InlayHint } from "vscode-languageserver";

/**
 * End-of-line badge for each commented line: `⟡ PR {n} · {k} comment(s)`.
 * `positions` are 0-based lines; `lineLengths` give EOL columns.
 */
export function buildInlayHints(
  prNumber: number,
  lineLengths: number[],
  positions: Map<number, number>,
): InlayHint[] {
  const out: InlayHint[] = [];
  for (const [line, threadCount] of positions) {
    if (line < 0 || line >= lineLengths.length) continue;
    out.push({
      position: { line, character: lineLengths[line] },
      label: `⟡ PR ${prNumber} · ${threadCount} comment${threadCount === 1 ? "" : "s"}`,
      kind: InlayHintKind.Parameter,
      paddingLeft: true,
    });
  }
  out.sort((a, b) => a.position.line - b.position.line);
  return out;
}
