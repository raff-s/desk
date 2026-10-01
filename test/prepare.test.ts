import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { prepare } from "../src/core/prepare.ts";
import { readStore } from "../src/core/store.ts";
import { commitFile, git, installFakeGh, makeFixture, prFixture, pushBranchFrom, rawPr, setPr, write } from "./helpers/fixture.ts";
import type { Fixture } from "./helpers/fixture.ts";

const worktreeOf = (fix: Fixture) => join(fix.base, "repo-pr-7");

test("creates a sibling worktree tracking the PR branch and writes the store", async () => {
  const { fix, head } = prFixture();
  const review = await prepare(fix.main, 7);

  assert.equal(review.worktree, worktreeOf(fix));
  assert.equal(git(review.worktree, "rev-parse", "HEAD"), head);
  assert.equal(git(review.worktree, "rev-parse", "--abbrev-ref", "feature@{upstream}"), "origin/feature");
  assert.equal(review.mode, "own");
  assert.equal(review.sync, "in-sync");
  assert.equal(review.canMakeChanges, true);
  assert.equal(review.baseOid, git(fix.main, "rev-parse", "origin/main"));
  assert.equal(review.key, "pr-7");
  assert.equal(review.storePath, join(fix.main, ".git", "desk", "pr-7.json"));

  const store = readStore(review.storePath)!;
  assert.equal(store.pr?.headOid, head);
  assert.equal(store.worktree, review.worktree);
});

test("reuses a worktree where the branch is already checked out", async () => {
  const { fix, head } = prFixture();
  git(fix.main, "fetch", "-q", "origin", "feature");
  git(fix.main, "checkout", "-q", "-b", "feature", "origin/feature");

  const review = await prepare(fix.main, 7);
  assert.equal(review.worktree, fix.main);
  assert.equal(existsSync(worktreeOf(fix)), false);
  assert.equal(review.sync, "in-sync");
  assert.equal(git(fix.main, "rev-parse", "HEAD"), head);

  // preparing from another worktree finds the same checkout
  const again = await prepare(fix.main, 7);
  assert.equal(again.worktree, fix.main);
});

test("second prepare reuses the worktree it created", async () => {
  const { fix } = prFixture();
  const first = await prepare(fix.main, 7);
  const second = await prepare(first.worktree, 7);
  assert.equal(second.worktree, first.worktree);
  assert.equal(second.storePath, first.storePath);
});

test("teammate PRs are comments-only", async () => {
  const { fix } = prFixture("alice");
  const review = await prepare(fix.main, 7);
  assert.equal(review.mode, "teammate");
  assert.equal(review.canMakeChanges, false);
});

test("sync: updated fast-forwards a clean worktree", async () => {
  const { fix, advance } = prFixture();
  const first = await prepare(fix.main, 7);
  const next = advance();
  const review = await prepare(fix.main, 7);
  assert.equal(review.sync, "updated");
  assert.match(review.syncDetail, /Fast-forwarded/);
  assert.equal(git(first.worktree, "rev-parse", "HEAD"), next);
  assert.equal(readStore(review.storePath)?.pr?.headOid, next);
});

test("sync: ahead when local has unpushed commits", async () => {
  const { fix } = prFixture();
  const first = await prepare(fix.main, 7);
  commitFile(first.worktree, "src/fix.ts", "fix\n");
  const review = await prepare(fix.main, 7);
  assert.equal(review.sync, "ahead");
  assert.match(review.syncDetail, /1 unpushed commit/);
  assert.equal(review.canMakeChanges, true);
});

test("sync: dirty wins over in-sync, ahead and behind, and never touches the tree", async () => {
  const { fix, advance } = prFixture();
  const first = await prepare(fix.main, 7);
  write(first.worktree, "src/feature.ts", "export const f = 2;\n");
  assert.equal((await prepare(fix.main, 7)).sync, "dirty");

  const before = git(first.worktree, "rev-parse", "HEAD");
  advance();
  const behind = await prepare(fix.main, 7);
  assert.equal(behind.sync, "dirty");
  assert.match(behind.syncDetail, /not updated/);
  assert.equal(git(first.worktree, "rev-parse", "HEAD"), before);
});

test("sync: diverged changes nothing and blocks changes", async () => {
  const { fix, advance } = prFixture();
  const first = await prepare(fix.main, 7);
  const local = commitFile(first.worktree, "src/local.ts", "local\n");
  advance();
  const review = await prepare(fix.main, 7);
  assert.equal(review.sync, "diverged");
  assert.equal(review.canMakeChanges, false);
  assert.equal(git(first.worktree, "rev-parse", "HEAD"), local);
});

test("cross-repository PRs use their own local branch, never the fork's branch name", async () => {
  const fix = makeFixture();
  const gh = installFakeGh();
  const head = pushBranchFrom(fix, "fork-work", "src/fork.ts", "fork\n");
  git(fix.origin, "update-ref", "refs/pull/7/head", head);
  setPr(gh, 7, rawPr({ headRefOid: head, headRefName: "main", isCrossRepository: true, author: { login: "bob" } }));

  const review = await prepare(fix.main, 7);
  assert.equal(review.worktree, worktreeOf(fix));
  assert.equal(git(review.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "pr-7-main");
  assert.equal(git(review.worktree, "rev-parse", "HEAD"), head);
  assert.equal(git(fix.main, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(review.mode, "teammate");
});

test("prepare . makes a local review against the default branch", async () => {
  const fix = makeFixture();
  git(fix.main, "checkout", "-q", "-b", "feat/x");
  commitFile(fix.main, "src/x.ts", "x\n");
  const review = await prepare(fix.main, ".");
  assert.equal(review.key, "local-feat-x");
  assert.equal(review.mode, "local");
  assert.equal(review.pr, null);
  assert.equal(review.worktree, fix.main);
  assert.equal(review.baseOid, git(fix.main, "rev-parse", "origin/main"));
  assert.equal(review.sync, "in-sync");
  assert.equal(review.canMakeChanges, true);

  write(fix.main, "src/x.ts", "changed\n");
  assert.equal((await prepare(fix.main, ".")).sync, "dirty");
});
