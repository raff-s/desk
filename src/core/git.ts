import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "./errors.ts";

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string, args: string[], input?: string): GitResult {
  const res = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (res.error) fail(`git failed to start: ${res.error.message}`);
  return { status: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
}

const chomp = (s: string) => s.replace(/\n$/, "");

export function git(cwd: string, args: string[], input?: string): string {
  const res = runGit(cwd, args, input);
  if (res.status !== 0) {
    fail(`git ${args[0]} failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return chomp(res.stdout);
}

export function tryGit(cwd: string, args: string[]): string | null {
  const res = runGit(cwd, args);
  return res.status === 0 ? chomp(res.stdout) : null;
}

export function repoRoot(cwd: string): string {
  const out = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (out.status !== 0) fail(`${cwd} is not inside a git repository`);
  return realpathSync(chomp(out.stdout));
}

export function commonDir(cwd: string): string {
  return realpathSync(resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"])));
}

export const headOid = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);

export const currentBranch = (cwd: string) =>
  tryGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);

export const isDirty = (cwd: string) =>
  git(cwd, ["status", "--porcelain", "--untracked-files=no"]) !== "";

export function hasObject(cwd: string, oid: string): boolean {
  return runGit(cwd, ["cat-file", "-e", `${oid}^{commit}`]).status === 0;
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return runGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

export const countCommits = (cwd: string, range: string) =>
  Number(git(cwd, ["rev-list", "--count", range]));

export function fileAtRev(cwd: string, rev: string, path: string): string | null {
  const res = runGit(cwd, ["show", `${rev}:${path}`]);
  return res.status === 0 ? res.stdout : null;
}

export interface Worktree {
  path: string;
  branch: string | null;
}

export function listWorktrees(cwd: string): Worktree[] {
  const out = git(cwd, ["worktree", "list", "--porcelain"]);
  return out
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "";
      const ref = lines.find((l) => l.startsWith("branch "))?.slice(7);
      return { path, branch: ref ? ref.replace(/^refs\/heads\//, "") : null };
    });
}

export const mainWorktree = (cwd: string) => listWorktrees(cwd)[0]!.path;

export function defaultBranch(cwd: string): string {
  const head = tryGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if (tryGit(cwd, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${name}`])) return name;
  }
  return fail("Cannot determine the default branch (no origin/HEAD, origin/main or origin/master)");
}

export function localBranchExists(cwd: string, branch: string): boolean {
  return runGit(cwd, ["show-ref", "--verify", "-q", `refs/heads/${branch}`]).status === 0;
}

export const shortOid = (oid: string) => oid.slice(0, 7);
