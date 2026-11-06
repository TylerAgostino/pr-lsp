import * as fs from "node:fs";
import * as path from "node:path";

export type DraftType = "comment" | "reply" | "review";

export interface DraftMeta {
  type: DraftType;
  pr: number;
  /** id of the top-level comment being replied to (reply drafts). */
  comment?: number;
  /** workspace-relative file path (comment drafts). */
  path?: string;
  /** 1-based RIGHT-side line (comment drafts). */
  line?: number;
  /** comment | approve | request_changes (review drafts). */
  event?: string;
}

export function draftDir(repoRoot: string, draftsDir: string): string {
  return path.join(repoRoot, draftsDir);
}

export function renderDraft(meta: DraftMeta, seedBody: string): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) lines.push(`${key}: ${value}`);
  }
  lines.push("---", "", seedBody, "");
  return lines.join("\n");
}

export function writeDraft(dir: string, meta: DraftMeta, seedBody: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const tag = meta.comment ?? meta.line;
  const name = tag != null ? `${meta.type}-${tag}-${Date.now()}.md` : `${meta.type}-${Date.now()}.md`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, renderDraft(meta, seedBody));
  return file;
}

export function isDraftPath(absPath: string, dir: string): boolean {
  const base = path.basename(absPath);
  if (base.startsWith("listing-")) return false; // read-only listings live alongside drafts
  const rel = path.relative(dir, absPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel) && rel.length > 0;
}

/** Filename shape produced by writeDraft; listing-* listings excluded. */
export const DRAFT_FILE_RE = /^(comment|reply|review)(-\d+)*\.md$/;

/** True while the body is still the untouched seed text for this draft. */
export function isUneditedDraft(meta: DraftMeta, body: string): boolean {
  return body === draftSeedBody(meta.type, { path: meta.path, line: meta.line }).trim();
}

/** Parse `---\nkey: value\n---\nbody`. Null when frontmatter is absent/bad. */
export function parseDraft(text: string): { meta: DraftMeta; body: string } | null {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):[ \t]*(.*)$/.exec(line.trim());
    if (kv) fields[kv[1]] = kv[2];
  }
  const type = fields.type;
  if (type !== "comment" && type !== "reply" && type !== "review") return null;
  const pr = Number(fields.pr);
  if (!Number.isInteger(pr) || pr <= 0) return null;
  const meta: DraftMeta = {
    type,
    pr,
    comment: fields.comment !== undefined ? Number(fields.comment) : undefined,
    path: fields.path,
    line: fields.line !== undefined ? Number(fields.line) : undefined,
    event: fields.event?.toLowerCase(),
  };
  if (
    (type === "reply" && !Number.isInteger(meta.comment)) ||
    (type === "comment" && (typeof meta.path !== "string" || !Number.isInteger(meta.line)))
  ) {
    return null;
  }
  return { meta, body: m[2].trim() };
}

export function draftSeedBody(
  type: DraftType,
  context: { commentId?: number; path?: string; line?: number },
): string {
  switch (type) {
    case "reply":
      return "Write your reply, then save.";
    case "comment":
      return `Write your review comment on ${context.path}:${context.line}, then save.`;
    case "review":
      return "Write the review summary, then save.\nChange `event:` to approve or request_changes to submit that instead.";
  }
}
