import { dirname, join, basename } from "node:path";
import { reanchor } from "./anchor.ts";
import { fail } from "./errors.ts";
import { currentUser, viewPr } from "./gh.ts";
import {
  commonDir, countCommits, currentBranch, defaultBranch, git, headOid, listWorktrees, localBranchExists,
  mainWorktree, repoRoot, runGit, shortOid,
} from "./git.ts";
import { emptyStore, localKey, prKey, readStore, storePathFor, updateStore } from "./store.ts";
import { inspectSync } from "./syncstate.ts";
import type { PreparedReview, PullRequestInfo, Store } from "./types.ts";

export function describeReview(store: Store, storePath: string): PreparedReview {
  const info = inspectSync(store.worktree, store.pr?.headOid ?? null);
  return {
    key: store.key,
    storePath,
    worktree: store.worktree,
    mode: store.mode,
    sync: info.sync,
    syncDetail: info.detail,
    baseOid: store.baseOid,
    pr: store.pr,
    canMakeChanges: store.mode !== "teammate" && info.sync !== "diverged",
  };
}

function fetchRefs(cwd: string, refspecs: string[]): void {
  const res = runGit(cwd, ["fetch", "origin", ...refspecs]);
  if (res.status !== 0) fail(`git fetch failed: ${res.stderr.trim()}`);
}

function localBranchFor(pr: PullRequestInfo): string {
  return pr.isCrossRepository ? `pr-${pr.number}-${pr.headRef}` : pr.headRef;
}

function ensureWorktree(repo: string, pr: PullRequestInfo): string {
  const branch = localBranchFor(pr);
  const existing = listWorktrees(repo).find((w) => w.branch === branch);

  const headSpec = pr.isCrossRepository
    ? `+refs/pull/${pr.number}/head:refs/desk/pr/${pr.number}`
    : `+refs/heads/${pr.headRef}:refs/remotes/origin/${pr.headRef}`;
  fetchRefs(repo, [headSpec, `+refs/heads/${pr.baseRef}:refs/remotes/origin/${pr.baseRef}`]);
  if (existing) return existing.path;

  const main = mainWorktree(repo);
  const path = join(dirname(main), `${basename(main)}-pr-${pr.number}`);
  const remoteHead = pr.isCrossRepository ? `refs/desk/pr/${pr.number}` : `origin/${pr.headRef}`;
  if (localBranchExists(repo, branch)) {
    git(repo, ["worktree", "add", path, branch]);
  } else {
    const track = pr.isCrossRepository ? [] : ["--track"];
    git(repo, ["worktree", "add", ...track, "-b", branch, path, remoteHead]);
  }
  if (!pr.isCrossRepository) {
    runGit(path, ["branch", `--set-upstream-to=origin/${pr.headRef}`, branch]);
  }
  return path;
}

async function prepareLocal(repo: string): Promise<PreparedReview> {
  const root = repoRoot(repo);
  const branch = currentBranch(root) ?? `detached-${shortOid(headOid(root))}`;
  const def = defaultBranch(root);
  runGit(root, ["fetch", "origin", `+refs/heads/${def}:refs/remotes/origin/${def}`]);
  const baseOid = git(root, ["merge-base", `origin/${def}`, "HEAD"]);

  const storePath = storePathFor(commonDir(root), localKey(branch));
  updateStore(
    storePath,
    (store) => {
      store.pr = null;
      store.mode = "local";
      store.worktree = root;
      store.baseOid = baseOid;
      reanchor(store);
    },
    () => emptyStore(localKey(branch)),
  );
  return finish(storePath);
}

async function preparePr(repo: string, number: number): Promise<PreparedReview> {
  const root = repoRoot(repo);
  const pr = await viewPr(root, number);
  const mode = pr.author === (await currentUser(root)) ? "own" : "teammate";
  const worktree = ensureWorktree(root, pr);

  const info = inspectSync(worktree, pr.headOid);
  let override: { sync: "updated"; detail: string } | null = null;
  if (info.canFastForward) {
    const behind = countCommits(worktree, `HEAD..${pr.headOid}`);
    git(worktree, ["merge", "--ff-only", pr.headOid]);
    override = { sync: "updated", detail: `Fast-forwarded to PR head ${shortOid(pr.headOid)} (${behind} new)` };
  }

  const baseOid = git(worktree, ["merge-base", `origin/${pr.baseRef}`, "HEAD"]);
  const storePath = storePathFor(commonDir(root), prKey(number));
  updateStore(
    storePath,
    (store) => {
      store.pr = pr;
      store.mode = mode;
      store.worktree = worktree;
      store.baseOid = baseOid;
      reanchor(store);
    },
    () => emptyStore(prKey(number)),
  );
  return finish(storePath, override);
}

function finish(storePath: string, override?: { sync: "updated"; detail: string } | null): PreparedReview {
  const review = describeReview(readStore(storePath)!, storePath);
  return override ? { ...review, sync: override.sync, syncDetail: override.detail } : review;
}

export async function prepare(repo: string, target: number | "."): Promise<PreparedReview> {
  return target === "." ? prepareLocal(repo) : preparePr(repo, target);
}

export function parseTarget(raw: string): number | "." {
  if (raw === ".") return ".";
  const match = /^#?(\d+)$/.exec(raw) ?? /\/pull\/(\d+)/.exec(raw);
  return match ? Number(match[1]) : fail(`Expected a PR number or '.', got '${raw}'`);
}
