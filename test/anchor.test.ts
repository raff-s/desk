import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprint, makeAnchor, reanchor } from "../src/core/anchor.ts";
import { addThread } from "../src/core/threads.ts";
import type { Thread } from "../src/core/types.ts";
import { APP_LINES, commitFile, git, lines, makeFixture, storeFor, write } from "./helpers/fixture.ts";

function setup(path = "src/app.ts", start = 3, end = 3, side: "new" | "old" = "new") {
  const fix = makeFixture();
  const store = storeFor(fix.main);
  const thread = addThread(store, {
    path, side, startLine: start, endLine: end, body: "why?", author: "you",
    anchor: makeAnchor(store, path, side, start, end),
  });
  return { fix, store, thread };
}

test("makeAnchor captures snippet, context and fingerprint; rejects bad ranges", () => {
  const { store, thread } = setup("src/app.ts", 3, 4);
  assert.deepEqual(thread.anchor.snippet, ["gamma", "delta"]);
  assert.deepEqual(thread.anchor.before, ["alpha", "beta"]);
  assert.deepEqual(thread.anchor.after, ["epsilon", "zeta", "eta"]);
  assert.equal(thread.anchor.fingerprint, fingerprint(["gamma", "delta"]));
  assert.throws(() => makeAnchor(store, "src/app.ts", "new", 7, 20), /outside/);
  assert.throws(() => makeAnchor(store, "nope.ts", "new", 1, 1), /does not exist/);
});

test("reanchor follows lines that moved", () => {
  const { fix, store, thread } = setup();
  commitFile(fix.main, "src/app.ts", lines("new1", "new2", ...APP_LINES));
  const changed = reanchor(store);
  assert.deepEqual(changed.map((t) => t.id), [thread.id]);
  assert.equal(thread.startLine, 5);
  assert.equal(thread.endLine, 5);
  assert.equal(thread.state, "draft");
});

test("reanchor reads uncommitted working-tree text", () => {
  const { fix, store, thread } = setup();
  write(fix.main, "src/app.ts", lines("x", ...APP_LINES));
  reanchor(store);
  assert.equal(thread.startLine, 4);
});

test("reanchor prefers the occurrence nearest the old line, then context", () => {
  const fix = makeFixture();
  commitFile(fix.main, "dup.ts", lines("a", "same", "b", "c", "d", "e", "same", "f"));
  const store = storeFor(fix.main);
  const thread = addThread(store, {
    path: "dup.ts", side: "new", startLine: 7, endLine: 7, body: "x", author: "you",
    anchor: makeAnchor(store, "dup.ts", "new", 7, 7),
  });
  commitFile(fix.main, "dup.ts", lines("zz", "a", "same", "b", "c", "d", "e", "same", "f"));
  reanchor(store);
  assert.equal(thread.startLine, 8);

  commitFile(fix.main, "tie.ts", lines("x", "same", "y", "z", "e", "same", "f"));
  const tied = addThread(store, {
    path: "tie.ts", side: "new", startLine: 4, endLine: 4, body: "y", author: "you",
    anchor: { commit: "", fingerprint: fingerprint(["same"]), snippet: ["same"], before: ["e"], after: ["f"] },
  });
  reanchor(store);
  assert.equal(tied.startLine, 6);
});

test("a thread's own commit that rewrote the lines marks it addressed", () => {
  const { fix, store, thread } = setup();
  thread.state = "making-changes";
  thread.commits.push(commitFile(fix.main, "src/app.ts", lines("alpha", "beta", "GAMMA!", ...APP_LINES.slice(3))));
  reanchor(store);
  assert.equal(thread.state, "addressed");
  // and it stays addressed on later passes
  reanchor(store);
  assert.equal(thread.state, "addressed");
});

test("lines changed by something else go stale and keep the old snippet", () => {
  const { fix, store, thread } = setup();
  commitFile(fix.main, "src/app.ts", lines("alpha", "beta", "GAMMA!", ...APP_LINES.slice(3)));
  reanchor(store);
  assert.equal(thread.state, "stale");
  assert.deepEqual(thread.anchor.snippet, ["gamma"]);
  assert.equal(thread.startLine, 3);
});

test("a missing file goes stale and keeps line numbers", () => {
  const { fix, store, thread } = setup();
  git(fix.main, "rm", "-q", "src/app.ts");
  git(fix.main, "commit", "-q", "-m", "remove");
  reanchor(store);
  assert.equal(thread.state, "stale");
  assert.equal(thread.startLine, 3);
});

test("dismissed, published-sent and old-side threads are left alone", () => {
  const { fix, store, thread } = setup();
  const old = addThread(store, {
    path: "src/app.ts", side: "old", startLine: 2, endLine: 2, body: "o", author: "you",
    anchor: makeAnchor(store, "src/app.ts", "old", 2, 2),
  });
  const imported: Thread = structuredClone(thread);
  imported.id = "t9";
  imported.publish = "published";
  imported.state = "sent";
  store.threads.push(imported);
  thread.state = "dismissed";
  rmSync(join(fix.main, "src/app.ts"));
  assert.deepEqual(reanchor(store), []);
  assert.equal(old.state, "draft");
  assert.equal(imported.state, "sent");
});
