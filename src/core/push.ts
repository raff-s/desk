import { createInterface } from "node:readline/promises";
import { fail } from "./errors.ts";
import { git, headOid, runGit, tryGit, currentBranch } from "./git.ts";
import { readStore, updateStore } from "./store.ts";
import { TRAILER } from "./done.ts";
import { requireChangesAllowed } from "./threads.ts";
import type { Store } from "./types.ts";

export interface PushOptions {
  squash: boolean;
  keep: boolean;
  yes: boolean;
}

interface LocalCommit {
  sha: string;
  trailers: string[];
}

const SQUASH_SUBJECT = "Address review feedback";

function pushedBoundary(store: Store): { ref: string; hasUpstream: boolean } {
  const cwd = store.worktree;
  if (tryGit(cwd, ["rev-parse", "--verify", "-q", "@{upstream}"])) return { ref: "@{upstream}", hasUpstream: true };
  const branch = currentBranch(cwd);
  const remote = branch ? `refs/remotes/origin/${branch}` : null;
  if (remote && tryGit(cwd, ["rev-parse", "--verify", "-q", remote])) return { ref: remote, hasUpstream: false };
  return { ref: store.baseOid, hasUpstream: false };
}

function unpushedCommits(store: Store, boundary: string): LocalCommit[] {
  const cwd = store.worktree;
  const shas = git(cwd, ["rev-list", "--reverse", `${boundary}..HEAD`]).split("\n").filter(Boolean);
  return shas.map((sha) => {
    const body = git(cwd, ["log", "-1", "--format=%B", sha]);
    const trailers = body.split("\n").filter((l) => l.startsWith(`${TRAILER}: `));
    return { sha, trailers };
  });
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

function squashPlan(commits: LocalCommit[]): { ok: true; run: LocalCommit[] } | { ok: false; reason: string } {
  const first = commits.findIndex((c) => c.trailers.length > 0);
  if (first < 0) return { ok: false, reason: "no unpushed review commits" };
  const run = commits.slice(first);
  if (run.some((c) => c.trailers.length === 0)) {
    return { ok: false, reason: "non-desk commits come after the first review commit" };
  }
  if (run.length < 2) return { ok: false, reason: "only one review commit" };
  return { ok: true, run };
}

function squash(store: Store, run: LocalCommit[]): string {
  const cwd = store.worktree;
  const parent = tryGit(cwd, ["rev-parse", "--verify", "-q", `${run[0]!.sha}^`]);
  if (!parent) fail("Cannot squash a root commit");
  const trailers = [...new Set(run.flatMap((c) => c.trailers))];
  const tree = git(cwd, ["rev-parse", "HEAD^{tree}"]);
  const message = `${SQUASH_SUBJECT}\n\n${trailers.join("\n")}\n`;
  const created = git(cwd, ["commit-tree", tree, "-p", parent, "-F", "-"], message);
  git(cwd, ["reset", "--soft", created]);
  return created;
}

function relink(storePath: string, oldShas: string[], created: string): void {
  updateStore(storePath, (s) => {
    for (const thread of s.threads) {
      if (!thread.commits.some((c) => oldShas.includes(c))) continue;
      const kept = thread.commits.filter((c) => !oldShas.includes(c));
      thread.commits = [...kept, created];
    }
  });
}

export async function pushReview(storePath: string, opts: PushOptions): Promise<{ squashed: boolean; pushed: string }> {
  const store = readStore(storePath) ?? fail(`No review at ${storePath}`);
  requireChangesAllowed(store, "push");
  if (opts.squash && opts.keep) fail("--squash and --keep cannot be combined");

  const boundary = pushedBoundary(store);
  const commits = unpushedCommits(store, boundary.ref);
  if (commits.length === 0) fail("Nothing to push: no unpushed commits");

  const plan = squashPlan(commits);
  let doSquash = false;
  if (!plan.ok && !opts.keep && !opts.squash && plan.reason.startsWith("non-desk")) {
    process.stderr.write(`Not squashing: ${plan.reason}. Pushing commits as they are.\n`);
  }
  if (opts.squash) {
    if (!plan.ok) fail(`Cannot squash: ${plan.reason}. Use --keep to push the commits as they are`);
    doSquash = true;
  } else if (!opts.keep && !opts.yes && plan.ok && process.stdin.isTTY) {
    doSquash = (await ask(`Squash ${plan.run.length} review commits into one? [s]quash/[k]eep: `)).startsWith("s");
  }

  const count = doSquash && plan.ok ? commits.length - plan.run.length + 1 : commits.length;
  if (!opts.yes) {
    if (!process.stdin.isTTY) fail("Refusing to push without confirmation: pass --yes");
    const target = boundary.hasUpstream ? "its upstream" : "origin";
    if (!(await ask(`Push ${count} commit(s) to ${target}? [y/N]: `)).startsWith("y")) fail("Push cancelled");
  }

  if (doSquash && plan.ok) {
    const created = squash(store, plan.run);
    relink(storePath, plan.run.map((c) => c.sha), created);
  }

  const args = boundary.hasUpstream ? ["push"] : ["push", "-u", "origin", "HEAD"];
  const res = runGit(store.worktree, args);
  if (res.status !== 0) fail(`git push failed: ${res.stderr.trim()}`);
  return { squashed: doSquash && plan.ok, pushed: headOid(store.worktree) };
}
