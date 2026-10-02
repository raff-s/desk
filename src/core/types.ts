export type Side = "old" | "new";

export type Author = "you" | "agent";

export type ThreadState =
  | "draft"
  | "sent"
  | "queued-changes"
  | "making-changes"
  | "addressed"
  | "stale"
  | "dismissed";

export type PublishState = "none" | "queued" | "published";

export type ReviewMode = "own" | "teammate" | "local";

export type SyncState =
  | "in-sync"
  | "updated"
  | "ahead"
  | "dirty"
  | "diverged";

export interface Message {
  author: Author;
  body: string;
  at: string;
}

export interface Anchor {
  commit: string;
  fingerprint: string;
  snippet: string[];
  before: string[];
  after: string[];
}

export interface GithubLink {
  commentId: number;
  url: string;
}

export interface Thread {
  id: string;
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  author: Author;
  state: ThreadState;
  publish: PublishState;
  messages: Message[];
  anchor: Anchor;
  commits: string[];
  github?: GithubLink;
  createdAt: string;
  updatedAt: string;
}

export type EventKind = "send" | "make-changes" | "reply";

export interface DeskEvent {
  seq: number;
  threadId: string;
  kind: EventKind;
  body?: string;
  at: string;
  consumed: boolean;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  author: string;
  baseRef: string;
  headRef: string;
  headOid: string;
  isCrossRepository: boolean;
}

export interface Store {
  version: 1;
  key: string;
  pr: PullRequestInfo | null;
  mode: ReviewMode;
  worktree: string;
  baseOid: string;
  nextThread: number;
  nextEvent: number;
  threads: Thread[];
  events: DeskEvent[];
}

export interface PreparedReview {
  key: string;
  storePath: string;
  worktree: string;
  mode: ReviewMode;
  sync: SyncState;
  syncDetail: string;
  baseOid: string;
  pr: PullRequestInfo | null;
  canMakeChanges: boolean;
}

export interface PrListItem {
  number: number;
  title: string;
  author: string;
  headRef: string;
  updatedAt: string;
  group: "review-requested" | "mine" | "other";
  worktree: string | null;
  openThreads: number;
}
