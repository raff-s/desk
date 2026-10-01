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
  const store = readStore(storePath) ?? fail(`No review at ${storePath}`);
  requireChangesAllowed(store, "done");
  const thread = findThread(store, id);
  if (thread.state === "dismissed") fail(`Thread ${thread.id} is dismissed`);

  const cwd = store.worktree;
  const scope = opts.paths.length > 0 ? ["--", ...opts.paths] : [];
  git(cwd, ["add", "-A", ...scope]);
  if (runGit(cwd, ["diff", "--cached", "--quiet", ...scope]).status === 0) {
    fail("Nothing to commit: the working tree has no changes" + (opts.paths.length ? " in the given paths" : ""));
  }
  const subject = opts.message?.trim() || commitSubject(thread);
  git(cwd, ["commit", "-m", subject, "-m", `${TRAILER}: ${store.key}/${thread.id}`, ...scope]);
  const commit = headOid(cwd);

  const updated = updateStore(storePath, (s) => {
    const t = findThread(s, id);
    t.commits.push(commit);
    t.state = "addressed";
    t.updatedAt = new Date().toISOString();
    reanchor(s);
    return t;
  });
  reloadHunk(store.worktree, store.baseOid);
  return { thread: updated, commit };
}
