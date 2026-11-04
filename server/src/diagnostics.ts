import { DiagnosticSeverity } from "vscode-languageserver";
import type { Thread } from "./model";
import type { AnchorResult } from "./anchor";

export interface AnchoredThread extends Thread {
  /** 0-based resolved buffer line (stale threads are not published). */
  anchor: AnchorResult;
}

export interface PublishedDiagnostic {
  severity: DiagnosticSeverity;
  source: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  message: string;
  data: { commentId: number; threadId: string | null; url: string };
}

/**
 * Diagnostics for one file's threads (stale already filtered out).
 * One per thread: whole-line Information range, `PR Review` source.
 */
export function buildDiagnostics(
  lineLengths: number[],
  threads: AnchoredThread[],
): PublishedDiagnostic[] {
  const out: PublishedDiagnostic[] = [];
  for (const t of threads) {
    const line = t.anchor.line;
    if (line < 0 || line >= lineLengths.length) continue;
    const firstLine = t.top.body.split("\n")[0].trim();
    const replies = t.replies.length;
    const suffix = replies > 0 ? ` (replies: ${replies})` : "";
    out.push({
      severity: DiagnosticSeverity.Information,
      source: "PR Review",
      range: { start: { line, character: 0 }, end: { line, character: lineLengths[line] } },
      message: `@${t.top.user?.login ?? "unknown"}: ${firstLine}${suffix}`,
      data: { commentId: t.top.id, threadId: t.threadId, url: t.top.html_url },
    });
  }
  return out;
}
