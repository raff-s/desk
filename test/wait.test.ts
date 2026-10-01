import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyStore, readStore, updateStore, writeStoreAtomic } from "../src/core/store.ts";
import { addThread, applyAction } from "../src/core/threads.ts";
import { waitForEvents } from "../src/core/wait.ts";

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "desk-wait-")), "pr-1.json");
  const store = emptyStore("pr-1");
  store.worktree = "/nonexistent";
  writeStoreAtomic(file, store);
  const send = (body: string) =>
    updateStore(file, (s) => {
      const t = addThread(s, {
        path: "a.ts", side: "new", startLine: 1, endLine: 1, body, author: "you",
        anchor: { commit: "", fingerprint: "", snippet: [], before: [], after: [] },
      });
      applyAction(s, t.id, "send");
      return t.id;
    });
  return { file, send };
}

const fast = { timeoutMs: 1000, pollMs: 20 };

test("returns pending events with their threads and consumes them", async () => {
  const { file, send } = setup();
  const a = send("one");
  const b = send("two");
  const result = await waitForEvents(file, fast);
  assert.deepEqual(result.events.map((e) => [e.threadId, e.kind]), [[a, "send"], [b, "send"]]);
  assert.deepEqual(result.threads.map((t) => t.id), [a, b]);
  assert.ok(readStore(file)!.events.every((e) => e.consumed));

  const again = await waitForEvents(file, { timeoutMs: 100, pollMs: 20 });
  assert.deepEqual(again, { events: [], threads: [] });
});

test("times out with no events", async () => {
  const { file } = setup();
  const started = Date.now();
  const result = await waitForEvents(file, { timeoutMs: 150, pollMs: 20 });
  assert.deepEqual(result, { events: [], threads: [] });
  assert.ok(Date.now() - started >= 140);
});

test("wakes up when an event arrives later", async () => {
  const { file, send } = setup();
  setTimeout(() => send("later"), 120);
  const result = await waitForEvents(file, { timeoutMs: 3000, pollMs: 20 });
  assert.equal(result.events.length, 1);
  assert.equal(result.threads[0]?.messages[0]?.body, "later");
});

test("timeout 0 waits until an event arrives", async () => {
  const { file, send } = setup();
  setTimeout(() => send("eventually"), 100);
  const result = await waitForEvents(file, { timeoutMs: 0, pollMs: 20 });
  assert.equal(result.events.length, 1);
});
