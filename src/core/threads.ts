import { rebaseAnchorOnCurrentText } from "./anchor.ts";
import { fail } from "./errors.ts";
import { canMakeChanges } from "./syncstate.ts";
import type { Anchor, Author, DeskEvent, EventKind, Message, Side, Store, Thread } from "./types.ts";

export const ACTIONS = ["send", "make-changes", "queue", "unqueue", "dismiss", "reopen"] as const;
export type Action = (typeof ACTIONS)[number];

export interface NewThread {
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  body: string;
  author: Author;
  anchor: Anchor;
}

const now = () => new Date().toISOString();

export function findThread(store: Store, id: string): Thread {
  const thread = store.threads.find((t) => t.id === id || t.id === `t${id}`);
  return thread ?? fail(`No thread ${id} in ${store.key}`);
}

export function requireChangesAllowed(store: Store, what: string): void {
  if (store.mode === "teammate") {
    const who = store.pr ? ` (PR #${store.pr.number} by ${store.pr.author})` : "";
    fail(`Teammate PRs are comments-only${who}: ${what} is not allowed`);
  }
  if (!canMakeChanges(store)) {
    fail(`${what} is not allowed: the local branch has diverged from the PR head`);
  }
}

function pushEvent(store: Store, threadId: string, kind: EventKind, body?: string): DeskEvent {
  const event: DeskEvent = { seq: store.nextEvent++, threadId, kind, at: now(), consumed: false };
  if (body) event.body = body;
  store.events.push(event);
  return event;
}

function pushMessage(thread: Thread, author: Author, body: string): Message {
  const message = { author, body, at: now() };
  thread.messages.push(message);
  thread.updatedAt = message.at;
  return message;
}

export function addThread(store: Store, input: NewThread): Thread {
  if (!input.body.trim()) fail("Comment body is empty");
  const at = now();
  const thread: Thread = {
    id: `t${store.nextThread++}`,
    path: input.path,
    side: input.side,
    startLine: input.startLine,
    endLine: input.endLine,
    author: input.author,
    state: "draft",
    publish: "none",
    messages: [{ author: input.author, body: input.body, at }],
    anchor: input.anchor,
    commits: [],
    createdAt: at,
    updatedAt: at,
  };
  store.threads.push(thread);
  return thread;
}

export function addReply(store: Store, id: string, body: string, author: Author): Thread {
  if (!body.trim()) fail("Reply body is empty");
  const thread = findThread(store, id);
  pushMessage(thread, author, body);
  if (author === "agent" && thread.state === "draft") thread.state = "sent";
  if (author === "you" && (thread.state === "sent" || thread.state === "addressed")) {
    pushEvent(store, thread.id, "reply", body);
  }
  return thread;
}

function requireState(thread: Thread, action: Action, allowed: Thread["state"][]): void {
  if (!allowed.includes(thread.state)) fail(`Cannot ${action} thread ${thread.id} while it is ${thread.state}`);
}

export function applyAction(store: Store, id: string, action: Action, body?: string): Thread {
  const thread = findThread(store, id);
  const extra = body?.trim() ? body : undefined;

  switch (action) {
    case "send":
      requireState(thread, action, ["draft", "addressed", "stale"]);
      if (extra) pushMessage(thread, "you", extra);
      thread.state = "sent";
      pushEvent(store, thread.id, "send", extra);
      break;
    case "make-changes":
      requireChangesAllowed(store, "make-changes");
      requireState(thread, action, ["draft", "sent", "addressed", "stale"]);
      if (extra) pushMessage(thread, "you", extra);
      thread.state = "making-changes";
      pushEvent(store, thread.id, "make-changes", extra);
      break;
    case "queue":
      if (store.mode === "local") fail("Local reviews cannot be published: there is no PR to queue comments for");
      if (thread.state === "dismissed") fail(`Thread ${thread.id} is dismissed`);
      if (thread.publish !== "none") fail(`Thread ${thread.id} is already ${thread.publish}`);
      thread.publish = "queued";
      break;
    case "unqueue":
      if (thread.publish !== "queued") fail(`Thread ${thread.id} is not queued`);
      thread.publish = "none";
      break;
    case "dismiss":
      if (thread.publish === "queued") thread.publish = "none";
      thread.state = "dismissed";
      break;
    case "reopen":
      requireState(thread, action, ["dismissed", "stale"]);
      if (thread.state === "stale") rebaseAnchorOnCurrentText(store, thread);
      thread.state = "draft";
      break;
  }
  thread.updatedAt = now();
  return thread;
}

export function isOpenThread(thread: Thread): boolean {
  return ["draft", "sent", "making-changes", "stale"].includes(thread.state);
}
