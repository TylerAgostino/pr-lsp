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

/**
 * Full cross-file listing of every PR review thread, one section per file.
 * Written to a `listing-*.md` file by `pr-review.listComments`; saving it
 * posts nothing (the draft router exempts `listing-` names).
 */
export function renderCommentListing(
  pr: { number: number; title: string; html_url: string },
  files: { rel: string; anchored: AnchoredThread[]; stale: Thread[] }[],
): string {
  const firstLine = (s: string) => s.split("\n")[0].trim();
  const line = (t: Thread, where: string) => {
    const replies = t.replies.length;
    const bits = [
      where.startsWith("_")
        ? `- _outdated_ @${t.top.user?.login ?? "unknown"}: ${firstLine(t.top.body)}${replies > 0 ? ` (replies: ${replies})` : ""}`
        : `- **${where}** @${t.top.user?.login ?? "unknown"}: ${firstLine(t.top.body)}${replies > 0 ? ` (replies: ${replies})` : ""}`,
      t.isResolved === true ? "*(resolved)*" : null,
      `[view](${t.top.html_url})`,
    ].filter(Boolean);
    return bits.join(" — ");
  };
  const out: string[] = [`# PR #${pr.number} — ${pr.title}`, pr.html_url, ""];
  for (const f of files) {
    const total = f.anchored.length + f.stale.length;
    if (total === 0) continue;
    out.push(`## ${f.rel} (${total})`, "");
    for (const t of f.anchored) out.push(line(t, `L${t.anchor.line + 1}`));
    for (const t of f.stale) out.push(line(t, "_outdated_"));
    out.push("");
  }
  out.push("_Saving this file does not post anything. Delete it when done._", "");
  return out.join("\n");
}
