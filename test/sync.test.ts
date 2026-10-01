import assert from "node:assert/strict";
import { test } from "node:test";
import { prepare } from "../src/core/prepare.ts";
import { syncReview } from "../src/core/sync.ts";
import { readStore, updateStore } from "../src/core/store.ts";
import { makeAnchor } from "../src/core/anchor.ts";
import { addThread } from "../src/core/threads.ts";
import { git, makeFixture, installFakeGh, prFixture } from "./helpers/fixture.ts";

const comment = (id: number, login: string, body: string) => ({
  databaseId: id, author: { login }, body, url: `https://github.com/acme/repo/pull/7#discussion_r${id}`,
});

const graphql = (nodes: unknown[]) => ({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });

test("imports unresolved GitHub threads once, linked by comment id", async () => {
  const { gh, fix } = prFixture("alice");
  const review = await prepare(fix.main, 7);
  gh.state.graphql = graphql([
    {
      isResolved: false, path: "src/app.ts", line: 4, startLine: 2, diffSide: "RIGHT",
      comments: { nodes: [comment(11, "bob", "why this?"), comment(12, "alice", "legacy")] },
    },
    { isResolved: false, path: "src/app.ts", line: 1, startLine: null, diffSide: "LEFT", comments: { nodes: [comment(21, "carol", "was fine")] } },
    { isResolved: true, path: "src/app.ts", line: 3, startLine: null, diffSide: "RIGHT", comments: { nodes: [comment(31, "bob", "done")] } },
    { isResolved: false, path: "src/app.ts", line: null, startLine: null, diffSide: "RIGHT", comments: { nodes: [comment(41, "bob", "outdated")] } },
  ]);
  gh.save();

  assert.deepEqual(await syncReview(review.storePath), { imported: 2 });
  const [first, second] = readStore(review.storePath)!.threads;
  assert.equal(first?.path, "src/app.ts");
  assert.deepEqual([first?.side, first?.startLine, first?.endLine], ["new", 2, 4]);
  assert.deepEqual([first?.author, first?.state, first?.publish], ["you", "sent", "published"]);
  assert.deepEqual(first?.messages.map((m) => m.body), ["@bob: why this?", "@alice: legacy"]);
  assert.deepEqual(first?.github, { commentId: 11, url: "https://github.com/acme/repo/pull/7#discussion_r11" });
  assert.deepEqual(first?.anchor.snippet, ["beta", "gamma", "delta"]);
  assert.deepEqual([second?.side, second?.startLine, second?.endLine], ["old", 1, 1]);

  assert.deepEqual(await syncReview(review.storePath), { imported: 0 });
  assert.equal(readStore(review.storePath)!.threads.length, 2);
});

test("skips threads already linked from our own published comments", async () => {
  const { gh, fix } = prFixture();
  const review = await prepare(fix.main, 7);
  updateStore(review.storePath, (s) => {
    const t = addThread(s, {
      path: "src/app.ts", side: "new", startLine: 2, endLine: 2, body: "mine", author: "you",
      anchor: makeAnchor(s, "src/app.ts", "new", 2, 2),
    });
    t.publish = "published";
    t.github = { commentId: 77, url: "u" };
  });
  gh.state.graphql = graphql([
    { isResolved: false, path: "src/app.ts", line: 2, startLine: null, diffSide: "RIGHT", comments: { nodes: [comment(77, "me", "mine")] } },
  ]);
  gh.save();
  assert.equal((await syncReview(review.storePath)).imported, 0);
  assert.equal(readStore(review.storePath)!.threads.length, 1);
});

test("local reviews have nothing to sync", async () => {
  const fix = makeFixture();
  installFakeGh();
  git(fix.main, "checkout", "-q", "-b", "scratch");
  const review = await prepare(fix.main, ".");
  await assert.rejects(syncReview(review.storePath), /no GitHub threads/);
});
