import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAnchor } from "../src/core/anchor.ts";
import { prepare } from "../src/core/prepare.ts";
import { publishReview } from "../src/core/publish.ts";
import { readStore, updateStore } from "../src/core/store.ts";
import { addReply, addThread, applyAction } from "../src/core/threads.ts";
import type { Author, Side } from "../src/core/types.ts";
import type { FakeGh } from "./helpers/fixture.ts";
import { commitFile, git, makeFixture, prFixture, installFakeGh } from "./helpers/fixture.ts";

const yes = { event: "COMMENT", body: "", yes: true, force: false } as const;

async function setup(author = "me") {
  const ctx = prFixture(author);
  const review = await prepare(ctx.fix.main, 7);
  const add = (path: string, start: number, end: number, body: string, who: Author = "you", side: Side = "new") =>
    updateStore(review.storePath, (s) =>
      addThread(s, { path, side, startLine: start, endLine: end, body, author: who, anchor: makeAnchor(s, path, side, start, end) }).id,
    );
  const queue = (id: string) => updateStore(review.storePath, (s) => void applyAction(s, id, "queue"));
  return { ...ctx, review, add, queue };
}

const posts = (gh: FakeGh) => gh.calls().filter((c) => c.args.includes("POST"));

test("publishes one review containing only queued threads, with the right positions", async () => {
  const { gh, head, review, add, queue } = await setup();
  const range = add("src/app.ts", 2, 4, "range comment");
  const old = add("src/app.ts", 1, 1, "old side comment", "you", "old");
  add("src/app.ts", 5, 5, "never queued");
  const agent = add("src/app.ts", 6, 6, "agent finding", "agent");
  const multi = add("src/app.ts", 7, 7, "first");
  updateStore(review.storePath, (s) => {
    addReply(s, multi, "agent chatter", "agent");
    addReply(s, multi, "second", "you");
  });
  [range, old, agent, multi].forEach(queue);

  const result = await publishReview(review.storePath, { ...yes, event: "REQUEST_CHANGES", body: "Overall" });
  assert.deepEqual(result.published, [range, old, agent, multi]);
  assert.match(result.reviewUrl, /pullrequestreview-99/);

  const [post] = posts(gh);
  assert.equal(posts(gh).length, 1);
  assert.deepEqual(post!.args, ["api", "--method", "POST", "repos/acme/repo/pulls/7/reviews", "--input", "-"]);
  assert.deepEqual(JSON.parse(post!.stdin), {
    commit_id: head,
    event: "REQUEST_CHANGES",
    body: "Overall",
    comments: [
      { path: "src/app.ts", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT", body: "range comment" },
      { path: "src/app.ts", line: 1, side: "LEFT", body: "old side comment" },
      { path: "src/app.ts", line: 6, side: "RIGHT", body: "agent finding" },
      { path: "src/app.ts", line: 7, side: "RIGHT", body: "first\n\nsecond" },
    ],
  });

  const threads = readStore(review.storePath)!.threads;
  assert.deepEqual(threads.map((t) => t.publish), ["published", "published", "none", "published", "published"]);
});

test("stores comment ids and urls returned by GitHub", async () => {
  const { gh, review, add, queue } = await setup();
  queue(add("src/app.ts", 2, 2, "link me"));
  gh.state.reviewComments = [{ id: 555, html_url: "https://github.com/acme/repo/pull/7#discussion_r555", path: "src/app.ts", body: "link me" }];
  gh.save();
  await publishReview(review.storePath, yes);
  assert.deepEqual(readStore(review.storePath)!.threads[0]?.github, {
    commentId: 555,
    url: "https://github.com/acme/repo/pull/7#discussion_r555",
  });
});

test("refuses when local HEAD differs from the PR head and a new-side thread is queued", async () => {
  const { gh, review, add, queue } = await setup();
  commitFile(review.worktree, "src/local.ts", "local\n");
  const newSide = add("src/app.ts", 2, 2, "new side");
  queue(newSide);
  await assert.rejects(publishReview(review.storePath, yes), /not the PR head/);
  assert.equal(posts(gh).length, 0);
  assert.equal(readStore(review.storePath)!.threads[0]?.publish, "queued");

  await publishReview(review.storePath, { ...yes, force: true });
  assert.equal(posts(gh).length, 1);
});

test("old-side-only reviews may be published from a different HEAD", async () => {
  const { gh, review, add, queue } = await setup();
  commitFile(review.worktree, "src/local.ts", "local\n");
  queue(add("src/app.ts", 2, 2, "old side", "you", "old"));
  await publishReview(review.storePath, yes);
  assert.equal(posts(gh).length, 1);
});

test("works on teammate PRs", async () => {
  const { gh, review, add, queue } = await setup("alice");
  queue(add("src/app.ts", 3, 3, "question"));
  await publishReview(review.storePath, { ...yes, event: "APPROVE" });
  assert.equal(JSON.parse(posts(gh)[0]!.stdin).event, "APPROVE");
});

test("refuses with nothing queued, but a bare approval is allowed", async () => {
  const { gh, review, add } = await setup();
  add("src/app.ts", 3, 3, "draft only");
  await assert.rejects(publishReview(review.storePath, yes), /Nothing to publish/);
  await publishReview(review.storePath, { ...yes, event: "APPROVE" });
  assert.deepEqual(JSON.parse(posts(gh)[0]!.stdin).comments, []);
});

test("without --yes and without a TTY it refuses instead of posting", async (t) => {
  if (process.stdin.isTTY) return t.skip("stdin is a TTY");
  const { gh, review, add, queue } = await setup();
  queue(add("src/app.ts", 3, 3, "c"));
  await assert.rejects(publishReview(review.storePath, { ...yes, yes: false }), /pass --yes/);
  assert.equal(posts(gh).length, 0);
});

test("local reviews cannot be published", async () => {
  const fix = makeFixture();
  installFakeGh();
  git(fix.main, "checkout", "-q", "-b", "scratch");
  const review = await prepare(fix.main, ".");
  await assert.rejects(publishReview(review.storePath, yes), /Local reviews cannot be published/);
});
