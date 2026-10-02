import { isAbsolute, relative, resolve } from "node:path";
import { makeAnchor, reanchor } from "./anchor.ts";
import type { Args } from "./args.ts";
import { doneThread, doneThreads } from "./done.ts";
import { fail } from "./errors.ts";
import { openPrForBranch } from "./gh.ts";
import { currentBranch, repoRoot } from "./git.ts";
import { execHunk, launchReview, openSpec } from "./open.ts";
import { describeReview, parseTarget, prepare } from "./prepare.ts";
import { listPrs } from "./prs.ts";
import { publishReview, REVIEW_EVENTS } from "./publish.ts";
import { pushReview } from "./push.ts";
import { locateReview } from "./review.ts";
import { updateStore } from "./store.ts";
import { syncReview } from "./sync.ts";
import { ACTIONS, addReply, addThread, applyAction, dispatchQueuedChanges, findThread } from "./threads.ts";
import type { Action } from "./threads.ts";
import type { DeskEvent, PreparedReview, Thread } from "./types.ts";
import { waitForEvents } from "./wait.ts";

export interface Output {
  data: unknown;
  text: string;
  exitCode?: number;
}

export type Handler = (args: Args) => Promise<Output>;

const repoOf = (a: Args) => a.str("repo") ?? process.cwd();
const prOf = (a: Args) => a.num("pr");
const authorOf = (a: Args) => a.pick("author", ["you", "agent"] as const, "you");
const locate = (a: Args) => locateReview(repoOf(a), prOf(a));

const clip = (text: string, max = 60) => {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};

export function threadLine(t: Thread): string {
  const lines = t.startLine === t.endLine ? `${t.startLine}` : `${t.startLine}-${t.endLine}`;
  const publish = t.publish === "none" ? "" : ` ${t.publish}`;
  return `${t.id}  ${t.author} ${t.state}${publish}  ${t.path}:${lines}  ${clip(t.messages.at(-1)?.body ?? "")}`;
}

function reviewText(r: PreparedReview): string {
  const title = r.pr ? `#${r.pr.number} ${r.pr.title} (${r.mode})` : `${r.key} (local)`;
  return [title, `worktree: ${r.worktree}`, `sync: ${r.sync} - ${r.syncDetail}`, `changes: ${r.canMakeChanges ? "allowed" : "not allowed"}`].join("\n");
}

function eventLine(e: DeskEvent): string {
  return `#${e.seq} ${e.kind} ${e.threadId}${e.body ? `: ${clip(e.body)}` : ""}`;
}

async function openTarget(a: Args, raw: string): Promise<Output> {
  const review = await prepare(repoOf(a), parseTarget(raw));
  const spec = openSpec(review);
  if (a.has("json")) return { data: { review, command: spec }, text: "" };
  return { data: null, text: "", exitCode: execHunk(spec) };
}

async function defaultTarget(a: Args): Promise<string> {
  const root = repoRoot(repoOf(a));
  const branch = currentBranch(root);
  const pr = branch ? await openPrForBranch(root, branch) : null;
  return pr === null ? "." : String(pr);
}

function relativePath(worktree: string, cwd: string, file: string): string {
  const candidates = isAbsolute(file) ? [file] : [resolve(cwd, file), resolve(worktree, file)];
  for (const abs of candidates) {
    const rel = relative(worktree, abs);
    if (!rel.startsWith("..") && !isAbsolute(rel) && rel !== "") return rel;
  }
  return fail(`${file} is not inside the worktree ${worktree}`);
}

export const commands: Record<string, Handler> = {
  async open(a) {
    return openTarget(a, a.positionals[1] ?? fail("Usage: desk open <pr|.>"));
  },

  async launch(a) {
    const result = await launchReview(repoOf(a), a.positionals[1] ?? fail("Usage: desk launch <pr|.>"));
    const text = result.tab.via === "print" ? result.tab.detail : `Opened ${result.review.key} via ${result.tab.via}: ${result.tab.detail}`;
    return { data: result, text };
  },

  async prepare(a) {
    const review = await prepare(repoOf(a), parseTarget(a.positionals[1] ?? fail("Usage: desk prepare <pr|.>")));
    return { data: review, text: reviewText(review) };
  },

  async prs(a) {
    const items = await listPrs(repoOf(a));
    const text = items
      .map((p) => `#${p.number} [${p.group}] ${clip(p.title, 50)} (${p.author})${p.worktree ? " wt" : ""}${p.openThreads ? ` ${p.openThreads} open` : ""}`)
      .join("\n");
    return { data: items, text: text || "No open PRs" };
  },

  async threads(a) {
    const { storePath } = await locate(a);
    const store = updateStore(storePath, (s) => {
      reanchor(s);
      return structuredClone(s);
    });
    const review = describeReview(store, storePath);
    const text = [reviewText(review), ...store.threads.map(threadLine)].join("\n");
    return { data: { review, threads: store.threads }, text: store.threads.length ? text : `${text}\nNo threads` };
  },

  async "store-path"(a) {
    const { storePath, store } = await locate(a);
    return { data: { key: store.key, storePath }, text: storePath };
  },

  async comment(a) {
    if (a.positionals[1] !== "add") fail("Usage: desk comment add --file F --line L [--end-line E] [--side new|old] --body B");
    const located = await locate(a);
    const side = a.pick("side", ["new", "old"] as const, "new");
    const start = a.requireNum("line");
    const end = a.num("end-line") ?? start;
    const body = a.require("body");
    const thread = updateStore(located.storePath, (store) => {
      const path = relativePath(store.worktree, process.cwd(), a.require("file"));
      const anchor = makeAnchor(store, path, side, start, end);
      return addThread(store, { path, side, startLine: start, endLine: end, body, author: authorOf(a), anchor });
    });
    return { data: thread, text: threadLine(thread) };
  },

  async reply(a) {
    const id = a.positionals[1] ?? fail("Usage: desk reply <id> --body B");
    const { storePath } = await locate(a);
    const thread = updateStore(storePath, (s) => addReply(s, id, a.require("body"), authorOf(a)));
    return { data: thread, text: threadLine(thread) };
  },

  async action(a) {
    const id = a.positionals[1];
    const action = a.positionals[2];
    if (!id || !action || !(ACTIONS as readonly string[]).includes(action)) {
      fail(`Usage: desk action <id> ${ACTIONS.join("|")} [--body B]`);
    }
    const { storePath } = await locate(a);
    const thread = updateStore(storePath, (s) => applyAction(s, id, action as Action, a.str("body")));
    return { data: thread, text: threadLine(thread) };
  },

  async changes(a) {
    if (a.positionals[1] !== "send") fail("Usage: desk changes send");
    const { storePath } = await locate(a);
    const threads = updateStore(storePath, (s) => structuredClone(dispatchQueuedChanges(s)));
    return {
      data: { threads },
      text: `Sent ${threads.length} queued change${threads.length === 1 ? "" : "s"} to the agent`,
    };
  },

  async wait(a) {
    const { storePath } = await locate(a);
    const timeoutMs = (a.num("timeout") ?? 0) * 1000;
    const pollMs = Number(process.env.DESK_WAIT_POLL_MS) || 500;
    const result = await waitForEvents(storePath, { timeoutMs, pollMs });
    const text = result.events.length
      ? [...result.events.map(eventLine), ...result.threads.map(threadLine)].join("\n")
      : "No events";
    return { data: result, text };
  },

  async done(a) {
    const ids = a.positionals.slice(1);
    if (ids.length === 0) fail("Usage: desk done <id...> [--message M] [--path P ...]");
    const { storePath } = await locate(a);
    if (ids.length === 1) {
      const result = doneThread(storePath, ids[0]!, { message: a.str("message"), paths: a.all("path") });
      return { data: result, text: `${result.thread.id} addressed in ${result.commit.slice(0, 7)}` };
    }
    const result = doneThreads(storePath, ids, { message: a.str("message"), paths: a.all("path") });
    return {
      data: result,
      text: `${result.threads.map((thread) => thread.id).join(", ")} addressed in ${result.commit.slice(0, 7)}`,
    };
  },

  async reanchor(a) {
    const { storePath } = await locate(a);
    const changed = updateStore(storePath, (s) => structuredClone(reanchor(s)));
    return { data: { changed }, text: changed.length ? changed.map(threadLine).join("\n") : "No changes" };
  },

  async sync(a) {
    const { storePath } = await locate(a);
    const result = await syncReview(storePath);
    return { data: result, text: `Imported ${result.imported} thread(s)` };
  },

  async publish(a) {
    const { storePath } = await locate(a);
    const result = await publishReview(storePath, {
      event: a.pick("event", REVIEW_EVENTS, "COMMENT"),
      body: a.str("body") ?? "",
      yes: a.has("yes"),
      force: a.has("force"),
    });
    return { data: result, text: `Published ${result.published.length} thread(s): ${result.reviewUrl}` };
  },

  async push(a) {
    const { storePath } = await locate(a);
    const result = await pushReview(storePath, { squash: a.has("squash"), keep: a.has("keep"), yes: a.has("yes") });
    return { data: result, text: `Pushed ${result.pushed.slice(0, 7)}${result.squashed ? " (squashed review commits)" : ""}` };
  },
};

export async function defaultCommand(a: Args): Promise<Output> {
  return openTarget(a, await defaultTarget(a));
}
