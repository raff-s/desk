import assert from "node:assert/strict";
import { test } from "node:test";
import { addReply, addThread, applyAction, findThread } from "../src/core/threads.ts";
import { emptyStore } from "../src/core/store.ts";
import type { Author, ReviewMode, Store } from "../src/core/types.ts";

function newStore(mode: ReviewMode = "own"): Store {
  const store = emptyStore("pr-7");
  store.mode = mode;
  store.worktree = "/nonexistent";
  return store;
}

function comment(store: Store, author: Author = "you", body = "rename this") {
  return addThread(store, {
    path: "a.ts", side: "new", startLine: 1, endLine: 2, body, author,
    anchor: { commit: "c", fingerprint: "f", snippet: ["x", "y"], before: [], after: [] },
  });
}

test("new threads start as draft/none for both authors", () => {
  const store = newStore();
  for (const author of ["you", "agent"] as const) {
    const t = comment(store, author);
    assert.equal(t.state, "draft");
    assert.equal(t.publish, "none");
    assert.equal(t.messages[0]?.author, author);
  }
  assert.deepEqual(store.threads.map((t) => t.id), ["t1", "t2"]);
  assert.equal(findThread(store, "2").id, "t2");
  assert.throws(() => findThread(store, "t9"), /No thread/);
});

test("send, make-changes and replies emit events in order", () => {
  const store = newStore();
  const t = comment(store);
  applyAction(store, t.id, "send");
  assert.equal(t.state, "sent");

  addReply(store, t.id, "also this", "you");
  applyAction(store, t.id, "make-changes", "do that, but also tests");
  assert.equal(t.state, "making-changes");
  assert.deepEqual(store.events.map((e) => [e.seq, e.kind, e.body]), [
    [1, "send", undefined],
    [2, "reply", "also this"],
    [3, "make-changes", "do that, but also tests"],
  ]);
  assert.ok(store.events.every((e) => !e.consumed && e.threadId === t.id));
  assert.equal(t.messages.at(-1)?.body, "do that, but also tests");
  assert.throws(() => applyAction(store, t.id, "make-changes"), /while it is making-changes/);
});

test("an agent reply moves draft to sent; a human reply on a draft emits nothing", () => {
  const store = newStore();
  const mine = comment(store, "you");
  addReply(store, mine.id, "note to self", "you");
  assert.equal(mine.state, "draft");
  assert.equal(store.events.length, 0);

  const theirs = comment(store, "agent", "I found a bug");
  addReply(store, theirs.id, "see line 4", "agent");
  assert.equal(theirs.state, "sent");
  assert.equal(store.events.length, 0);
});

test("publish state: queue, unqueue, refusals", () => {
  const store = newStore("teammate");
  const t = comment(store);
  applyAction(store, t.id, "queue");
  assert.equal(t.publish, "queued");
  assert.throws(() => applyAction(store, t.id, "queue"), /already queued/);
  applyAction(store, t.id, "unqueue");
  assert.equal(t.publish, "none");
  assert.throws(() => applyAction(store, t.id, "unqueue"), /not queued/);

  const local = newStore("local");
  assert.throws(() => applyAction(local, comment(local).id, "queue"), /cannot be published/);
});

test("dismiss clears the queue; reopen brings a thread back as draft", () => {
  const store = newStore();
  const t = comment(store);
  applyAction(store, t.id, "queue");
  applyAction(store, t.id, "dismiss");
  assert.equal(t.state, "dismissed");
  assert.equal(t.publish, "none");
  assert.throws(() => applyAction(store, t.id, "queue"), /dismissed/);
  applyAction(store, t.id, "reopen");
  assert.equal(t.state, "draft");
  assert.throws(() => applyAction(store, t.id, "reopen"), /Cannot reopen/);
});

test("teammate PRs are comments-only: make-changes refused, send and queue allowed", () => {
  const store = newStore("teammate");
  store.pr = {
    number: 7, title: "t", url: "u", author: "alice", baseRef: "main", headRef: "f", headOid: "o", isCrossRepository: false,
  };
  const t = comment(store);
  assert.throws(() => applyAction(store, t.id, "make-changes"), /comments-only.*alice/);
  assert.equal(t.state, "draft");
  assert.equal(store.events.length, 0);
  applyAction(store, t.id, "send");
  applyAction(store, t.id, "queue");
  assert.equal(t.state, "sent");
});

test("empty bodies are rejected", () => {
  const store = newStore();
  assert.throws(() => comment(store, "you", "  "), /empty/);
  const t = comment(store);
  assert.throws(() => addReply(store, t.id, "", "you"), /empty/);
});
