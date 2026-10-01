import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAnchor } from "../src/core/anchor.ts";
import { doneThread } from "../src/core/done.ts";
import { prepare } from "../src/core/prepare.ts";
import { pushReview } from "../src/core/push.ts";
import { readStore, updateStore } from "../src/core/store.ts";
import { addThread } from "../src/core/threads.ts";
import { commitFile, git, prFixture, write } from "./helpers/fixture.ts";

async function setup(author = "me") {
  const ctx = prFixture(author);
  const review = await prepare(ctx.fix.main, 7);
  updateStore(review.storePath, (s) => {
    for (const body of ["first comment", "second comment", "third comment"]) {
      addThread(s, {
        path: "src/feature.ts", side: "new", startLine: 1, endLine: 1, body, author: "you",
        anchor: makeAnchor(s, "src/feature.ts", "new", 1, 1),
      });
    }
  });
  let n = 0;
  const fixThread = (id: string) => {
    write(review.worktree, `src/fix-${++n}.ts`, `fix ${n}\n`);
    return doneThread(review.storePath, id, { paths: [] }).commit;
  };
  const remoteHead = () => git(ctx.fix.origin, "rev-parse", "refs/heads/feature");
  return { ...ctx, review, fixThread, remoteHead };
}

const opts = { squash: false, keep: false, yes: true };
const subjects = (cwd: string, range: string) => git(cwd, "log", "--format=%s", range).split("\n");

test("--squash folds the trailing review commits into one, keeps every trailer and relinks threads", async () => {
  const { review, head, fixThread, remoteHead } = await setup();
  const [a, b] = [fixThread("t1"), fixThread("t2")];

  const result = await pushReview(review.storePath, { ...opts, squash: true });
  const tip = git(review.worktree, "rev-parse", "HEAD");
  assert.equal(result.squashed, true);
  assert.equal(result.pushed, tip);
  assert.equal(remoteHead(), tip);
  assert.notEqual(tip, b);
  assert.equal(git(review.worktree, "rev-parse", "HEAD^"), head);
  assert.deepEqual(subjects(review.worktree, `${head}..HEAD`), ["Address review feedback"]);
  const body = git(review.worktree, "log", "-1", "--format=%B");
  assert.match(body, /Desk-Thread: pr-7\/t1/);
  assert.match(body, /Desk-Thread: pr-7\/t2/);
  assert.equal(git(review.worktree, "status", "--porcelain"), "");

  const threads = readStore(review.storePath)!.threads;
  assert.deepEqual(threads[0]?.commits, [tip]);
  assert.deepEqual(threads[1]?.commits, [tip]);
  assert.deepEqual(threads[2]?.commits, []);
  assert.ok(![a, b].includes(tip));
});

test("squash never rewrites commits that were already pushed", async () => {
  const { review, fixThread, remoteHead } = await setup();
  const pushedCommit = fixThread("t1");
  await pushReview(review.storePath, { ...opts, keep: true });
  assert.equal(remoteHead(), pushedCommit);

  fixThread("t2");
  fixThread("t3");
  const result = await pushReview(review.storePath, { ...opts, squash: true });
  assert.equal(result.squashed, true);
  assert.equal(git(review.worktree, "rev-parse", "HEAD^"), pushedCommit);
  assert.equal(subjects(review.worktree, `${pushedCommit}..HEAD`).length, 1);
  assert.equal(remoteHead(), git(review.worktree, "rev-parse", "HEAD"));
  assert.equal(git(review.worktree, "rev-list", "--count", `${pushedCommit}..${remoteHead()}`), "1");
  assert.deepEqual(readStore(review.storePath)!.threads[0]?.commits, [pushedCommit]);
});

test("--keep pushes the commits unchanged", async () => {
  const { review, fixThread, remoteHead } = await setup();
  fixThread("t1");
  const tip = fixThread("t2");
  const result = await pushReview(review.storePath, { ...opts, keep: true });
  assert.equal(result.squashed, false);
  assert.equal(remoteHead(), tip);
  assert.equal(readStore(review.storePath)!.threads[1]?.commits[0], tip);
});

test("--squash refuses when non-desk commits follow the first review commit", async () => {
  const { review, fixThread, remoteHead } = await setup();
  const before = remoteHead();
  fixThread("t1");
  commitFile(review.worktree, "src/manual.ts", "manual\n", "manual work");
  fixThread("t2");
  const head = git(review.worktree, "rev-parse", "HEAD");

  await assert.rejects(pushReview(review.storePath, { ...opts, squash: true }), /non-desk commits.*--keep/);
  assert.equal(git(review.worktree, "rev-parse", "HEAD"), head);
  assert.equal(remoteHead(), before);

  assert.equal((await pushReview(review.storePath, { ...opts, keep: true })).squashed, false);
  assert.equal(remoteHead(), head);
});

test("a single review commit cannot be squashed; nothing to push is an error", async () => {
  const { review, fixThread } = await setup();
  await assert.rejects(pushReview(review.storePath, opts), /Nothing to push/);
  fixThread("t1");
  await assert.rejects(pushReview(review.storePath, { ...opts, squash: true }), /only one review commit/);
});

test("push is refused on teammate PRs", async () => {
  const { review } = await setup("alice");
  commitFile(review.worktree, "src/x.ts", "x\n");
  await assert.rejects(pushReview(review.storePath, opts), /comments-only/);
});

test("a non-fast-forward push fails instead of force-pushing", async () => {
  const { review, fixThread, remoteHead, advance } = await setup();
  fixThread("t1");
  const moved = advance("src/remote.ts");
  await assert.rejects(pushReview(review.storePath, opts), /git push failed/);
  assert.equal(remoteHead(), moved);
});
