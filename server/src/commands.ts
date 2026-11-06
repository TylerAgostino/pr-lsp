// Exact command id literals — load-bearing across code actions, palette, and drafts.
export const CMD_REFRESH = "pr-review.refresh";
export const CMD_DRAFT_REVIEW = "pr-review.draftReview";
export const CMD_CREATE_COMMENT_DRAFT = "pr-review.createCommentDraft";
export const CMD_REACT = "pr-review.react";
export const CMD_RESOLVE_THREAD = "pr-review.resolveThread";
export const CMD_VIEW_ON_GITHUB = "pr-review.viewOnGithub";
export const CMD_SUMMARY = "pr-review.summary";
export const CMD_LIST_COMMENTS = "pr-review.listComments";
export const CMD_DELETE_COMMENT = "pr-review.deleteComment";
export const CMD_REMOVE_REACTION = "pr-review.removeReaction";

export const ALL_COMMANDS: string[] = [
  CMD_REFRESH,
  CMD_DRAFT_REVIEW,
  CMD_CREATE_COMMENT_DRAFT,
  CMD_REACT,
  CMD_REMOVE_REACTION,
  CMD_RESOLVE_THREAD,
  CMD_DELETE_COMMENT,
  CMD_VIEW_ON_GITHUB,
  CMD_SUMMARY,
  CMD_LIST_COMMENTS,
];

// GitHub reaction content values (API-legal).
export const REACTIONS: { content: string; emoji: string }[] = [
  { content: "+1", emoji: "👍" },
  { content: "-1", emoji: "👎" },
  { content: "laugh", emoji: "😄" },
  { content: "hooray", emoji: "🎉" },
  { content: "confused", emoji: "😕" },
  { content: "heart", emoji: "❤️" },
  { content: "rocket", emoji: "🚀" },
  { content: "eyes", emoji: "👀" },
];

// GitHub review events.
export const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

export interface ReactArgs {
  commentId: number;
  content: string;
}

export interface ResolveThreadArgs {
  threadId: string;
  resolved: boolean;
}

export interface ViewOnGithubArgs {
  url: string;
}
