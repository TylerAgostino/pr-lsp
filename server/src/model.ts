import type { ReviewComment, ThreadState } from "./github";

/** A top-level review comment plus its replies (GitHub threading by id). */
export interface Thread {
  top: ReviewComment;
  replies: ReviewComment[];
  threadId: string | null;
  isResolved: boolean | null;
}

export function groupThreads(comments: ReviewComment[]): Thread[] {
  const byId = new Map<number, ReviewComment>();
  for (const c of comments) byId.set(c.id, c);
  const repliesByTop = new Map<number, ReviewComment[]>();
  const roots: ReviewComment[] = [];
  for (const c of comments) {
    if (c.in_reply_to_id !== null && byId.has(c.in_reply_to_id)) {
      const list = repliesByTop.get(c.in_reply_to_id);
      if (list) list.push(c);
      else repliesByTop.set(c.in_reply_to_id, [c]);
    } else {
      roots.push(c);
    }
  }
  return roots.map((top) => ({
    top,
    replies: repliesByTop.get(top.id) ?? [],
    threadId: null,
    isResolved: null,
  }));
}

/** Attach GraphQL thread state (by top comment id) onto grouped threads. */
export function attachThreadState(threads: Thread[], states: Map<number, ThreadState>): void {
  for (const t of threads) {
    const s = states.get(t.top.id);
    if (s) {
      t.threadId = s.threadId;
      t.isResolved = s.isResolved;
    }
  }
}
