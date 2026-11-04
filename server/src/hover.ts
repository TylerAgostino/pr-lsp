import { REACTIONS } from "./commands";
import type { ReactionCounts } from "./github";
import type { AnchoredThread } from "./diagnostics";

function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const mins = Math.floor((nowMs - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

function reactionSummary(counts: ReactionCounts): string {
  const parts: string[] = [];
  for (const r of REACTIONS) {
    const n = (counts as unknown as Record<string, unknown>)[r.content];
    if (typeof n === "number" && n > 0) parts.push(`${r.emoji}${n}`);
  }
  return parts.join(" ");
}

/** One Markdown card per anchored thread on the hovered line. */
export function buildHoverMarkdown(
  prNumber: number,
  prUrl: string,
  threads: AnchoredThread[],
  nowMs: number,
): string | null {
  if (threads.length === 0) return null;
  const blocks = threads.map((t) => {
    const bits = [
      `**@${t.top.user?.login ?? "unknown"}** commented ${relativeTime(t.top.created_at, nowMs)}`,
      `[PR #${prNumber}](${prUrl})`,
    ];
    if (t.isResolved === true) bits.push("resolved");
    const reactions = reactionSummary(t.top.reactions);
    const header = bits.join(" · ") + (reactions ? ` · ${reactions}` : "");
    const replies = t.replies.map((r) => `> **@${r.user?.login ?? "unknown"}**: ${r.body.replace(/\n/g, "\n> ")}`);
    return [
      header,
      "---",
      t.top.body,
      ...(replies.length > 0 ? ["", ...replies] : []),
      `🔗 [View on GitHub](${t.top.html_url})`,
      "💡 Ctrl-. (or right-click → code actions) to react, reply, or resolve",
    ].join("\n");
  });
  return blocks.join("\n\n");
}
