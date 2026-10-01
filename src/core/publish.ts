import { createInterface } from "node:readline/promises";
import { fail } from "./errors.ts";
import { ghJson, repoSlug, viewPr } from "./gh.ts";
import { headOid } from "./git.ts";
import { readStore, updateStore } from "./store.ts";
import type { Store, Thread } from "./types.ts";

export const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

export interface PublishOptions {
  event: ReviewEvent;
  body: string;
  yes: boolean;
  force: boolean;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
  start_line?: number;
  start_side?: "RIGHT" | "LEFT";
}

export interface ReviewPayload {
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
}

interface PostedComment {
  id: number;
  html_url: string;
  path: string;
  body: string;
}

export function commentBody(thread: Thread): string {
  if (thread.author === "agent") return thread.messages[0]?.body ?? "";
  return thread.messages
    .filter((m) => m.author === "you")
    .map((m) => m.body)
    .join("\n\n");
}

export function toReviewComment(thread: Thread): ReviewComment {
  const side = thread.side === "new" ? "RIGHT" : "LEFT";
  const comment: ReviewComment = { path: thread.path, line: thread.endLine, side, body: commentBody(thread) };
  if (thread.startLine < thread.endLine) {
    comment.start_line = thread.startLine;
    comment.start_side = side;
  }
  return comment;
}

export const queuedThreads = (store: Store) =>
  store.threads.filter((t) => t.publish === "queued" && t.state !== "dismissed");

export function buildPayload(store: Store, prHeadOid: string, opts: Pick<PublishOptions, "event" | "body">): ReviewPayload {
  return {
    commit_id: prHeadOid,
    event: opts.event,
    body: opts.body,
    comments: queuedThreads(store).map(toReviewComment),
  };
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

export async function publishReview(
  storePath: string,
  opts: PublishOptions,
): Promise<{ reviewUrl: string; published: string[] }> {
  const store = readStore(storePath) ?? fail(`No review at ${storePath}`);
  if (store.mode === "local" || !store.pr) fail("Local reviews cannot be published: there is no PR");

  const queued = queuedThreads(store);
  if (queued.length === 0 && opts.event === "COMMENT" && !opts.body.trim()) {
    fail("Nothing to publish: no queued threads (queue one with: desk action <id> queue)");
  }

  const pr = await viewPr(store.worktree, store.pr.number);
  const head = headOid(store.worktree);
  if (head !== pr.headOid && !opts.force && queued.some((t) => t.side === "new")) {
    fail(
      `Local HEAD ${head.slice(0, 7)} is not the PR head ${pr.headOid.slice(0, 7)}; ` +
        "comments on the new side would land on the wrong lines. Run desk prepare, or pass --force",
    );
  }

  if (!opts.yes) {
    if (!process.stdin.isTTY) fail("Refusing to publish without confirmation: pass --yes");
    const question = `Post ${opts.event} review with ${queued.length} comment(s) on PR #${pr.number}? [y/N]: `;
    if (!(await confirm(question))) fail("Publish cancelled");
  }

  const slug = await repoSlug(store.worktree);
  const payload = buildPayload(store, pr.headOid, opts);
  const posted = await ghJson<{ id: number; html_url: string }>(
    store.worktree,
    ["api", "--method", "POST", `repos/${slug}/pulls/${pr.number}/reviews`, "--input", "-"],
    JSON.stringify(payload),
  );

  const links = await fetchLinks(store.worktree, slug, pr.number, posted.id);
  const published = queued.map((t) => t.id);
  updateStore(storePath, (s) => {
    queued.forEach((queuedThread, index) => {
      const thread = s.threads.find((t) => t.id === queuedThread.id);
      if (!thread) return;
      thread.publish = "published";
      thread.updatedAt = new Date().toISOString();
      const link = matchLink(links, payload.comments[index]!);
      if (link) thread.github = { commentId: link.id, url: link.html_url };
    });
  });
  return { reviewUrl: posted.html_url, published };
}

async function fetchLinks(cwd: string, slug: string, pr: number, reviewId: number): Promise<PostedComment[]> {
  try {
    return await ghJson<PostedComment[]>(cwd, ["api", `repos/${slug}/pulls/${pr}/reviews/${reviewId}/comments`]);
  } catch {
    return [];
  }
}

function matchLink(links: PostedComment[], comment: ReviewComment): PostedComment | undefined {
  return links.find((l) => l.path === comment.path && l.body === comment.body);
}
