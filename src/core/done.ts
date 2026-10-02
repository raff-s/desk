import { spawnSync } from "node:child_process";
import { reanchor } from "./anchor.ts";
import { fail } from "./errors.ts";
import { git, headOid, runGit } from "./git.ts";
import { readStore, updateStore } from "./store.ts";
import { findThread, requireChangesAllowed } from "./threads.ts";
import type { Thread } from "./types.ts";

export interface DoneOptions {
  message?: string;
  paths: string[];
}

export const TRAILER = "Desk-Thread";

export function commitSubject(thread: Thread): string {
  const first = (thread.messages[0]?.body ?? "").split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  if (!first) return "Address review feedback";
  return first.length > 72 ? `${first.slice(0, 69).trimEnd()}...` : first;
}

export function reloadHunk(worktree: string, baseOid: string): void {
  spawnSync(process.env.DESK_HUNK || "hunk", ["session", "reload", "--repo", worktree, "--", "diff", baseOid], {
    stdio: "ignore",
    timeout: 15000,
  });
}

export function doneThread(storePath: string, id: string, opts: DoneOptions): { thread: Thread; commit: string } {
  const result = doneThreads(storePath, [id], opts);
  return { thread: result.threads[0]!, commit: result.commit };
}

export function doneThreads(storePath: string, ids: string[], opts: DoneOptions): { threads: Thread[]; commit: string } {
  if (ids.length === 0) fail("No threads supplied to done");
  const store = readStore(storePath) ?? fail(`No review at ${storePath}`);
  requireChangesAllowed(store, "done");
  const threads = ids.map((id) => findThread(store, id));
  for (const thread of threads) {
    if (thread.state === "dismissed") fail(`Thread ${thread.id} is dismissed`);
  }

  const cwd = store.worktree;
  const scope = opts.paths.length > 0 ? ["--", ...opts.paths] : [];
  git(cwd, ["add", "-A", ...scope]);
  if (runGit(cwd, ["diff", "--cached", "--quiet", ...scope]).status === 0) {
    fail("Nothing to commit: the working tree has no changes" + (opts.paths.length ? " in the given paths" : ""));
  }
  const subject = opts.message?.trim() || (threads.length === 1 ? commitSubject(threads[0]!) : "Address review feedback");
  const trailers = threads.flatMap((thread) => ["-m", `${TRAILER}: ${store.key}/${thread.id}`]);
  git(cwd, ["commit", "-m", subject, ...trailers, ...scope]);
  const commit = headOid(cwd);

  const updated = updateStore(storePath, (s) => {
    const done = ids.map((id) => findThread(s, id));
    for (const thread of done) {
      thread.commits.push(commit);
      thread.state = "addressed";
      thread.updatedAt = new Date().toISOString();
    }
    reanchor(s);
    return done;
  });
  reloadHunk(store.worktree, store.baseOid);
  return { threads: updated, commit };
}
