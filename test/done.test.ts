import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAnchor } from "../src/core/anchor.ts";
import { commitSubject, doneThread } from "../src/core/done.ts";
import { prepare } from "../src/core/prepare.ts";
import { readStore, updateStore } from "../src/core/store.ts";
import { addThread, applyAction } from "../src/core/threads.ts";
import { git, prFixture, write } from "./helpers/fixture.ts";

async function setup(author = "me", body = "Use a descriptive name here") {
  const ctx = prFixture(author);
  const review = await prepare(ctx.fix.main, 7);
  updateStore(review.storePath, (s) => {
    addThread(s, {
      path: "src/feature.ts", side: "new", startLine: 1, endLine: 1, body, author: "you",
      anchor: makeAnchor(s, "src/feature.ts", "new", 1, 1),
    });
  });
  return { ...ctx, review };
}

test("done commits all changes with the thread summary and a Desk-Thread trailer", async () => {
  const { review } = await setup();
  updateStore(review.storePath, (s) => void applyAction(s, "t1", "make-changes"));
  write(review.worktree, "src/feature.ts", "export const renamed = 1;\n");
  write(review.worktree, "src/new.ts", "new\n");

  const { thread, commit } = doneThread(review.storePath, "t1", { paths: [] });
  assert.equal(git(review.worktree, "rev-parse", "HEAD"), commit);
  assert.equal(git(review.worktree, "log", "-1", "--format=%s"), "Use a descriptive name here");
  assert.match(git(review.worktree, "log", "-1", "--format=%B"), /\n\nDesk-Thread: pr-7\/t1$/);
  assert.equal(git(review.worktree, "status", "--porcelain"), "");
  assert.deepEqual(thread.commits, [commit]);
  assert.equal(readStore(review.storePath)?.threads[0]?.state, "addressed");
});

test("done honours --message and --path", async () => {
  const { review } = await setup();
  write(review.worktree, "src/feature.ts", "export const renamed = 1;\n");
  write(review.worktree, "src/other.ts", "other\n");

  doneThread(review.storePath, "t1", { paths: ["src/feature.ts"], message: "Rename constant" });
  assert.equal(git(review.worktree, "log", "-1", "--format=%s"), "Rename constant");
  assert.equal(git(review.worktree, "show", "--name-only", "--format=", "HEAD"), "src/feature.ts");
  assert.equal(git(review.worktree, "status", "--porcelain"), "?? src/other.ts");
});

test("done refuses when there is nothing to commit", async () => {
  const { review } = await setup();
  assert.throws(() => doneThread(review.storePath, "t1", { paths: [] }), /Nothing to commit/);
  assert.equal(readStore(review.storePath)?.threads[0]?.commits.length, 0);
});

test("done is refused on teammate PRs and commits nothing", async () => {
  const { review } = await setup("alice");
  const before = git(review.worktree, "rev-parse", "HEAD");
  write(review.worktree, "src/feature.ts", "edited\n");
  assert.throws(() => doneThread(review.storePath, "t1", { paths: [] }), /comments-only/);
  assert.equal(git(review.worktree, "rev-parse", "HEAD"), before);
});

test("commit subjects are the first line, at most 72 characters", () => {
  const long = "x".repeat(100);
  const thread = { messages: [{ author: "you", body: `${long}\nsecond`, at: "" }] };
  const subject = commitSubject(thread as never);
  assert.equal(subject.length, 72);
  assert.ok(subject.endsWith("..."));
  assert.equal(commitSubject({ messages: [{ author: "you", body: "\n  Fix it  \nmore", at: "" }] } as never), "Fix it");
  assert.equal(commitSubject({ messages: [] } as never), "Address review feedback");
});
