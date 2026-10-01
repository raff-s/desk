import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrListItem, Thread } from "../../src/core/types.ts";
import { availableActions, filterPrs, footer, noteFor, prefix, threadAt, wrap } from "../format.ts";

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "1",
    path: "src/a.ts",
    side: "new",
    startLine: 10,
    endLine: 10,
    author: "agent",
    state: "draft",
    publish: "none",
    messages: [{ author: "agent", body: "First line\nmore detail", at: "2026-01-01T00:00:00Z" }],
    anchor: { commit: "", fingerprint: "", snippet: ["const x = 1;"], before: [], after: [] },
    commits: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const keys = { send: "S", "make-changes": "i", queue: "p", reply: "R", dismiss: "x" } as const;
const keyFor = (a: keyof typeof keys) => keys[a];

test("prefix shows state, author, addressed sha and publish badge", () => {
  assert.equal(prefix(thread()), "[agent · draft]");
  assert.equal(prefix(thread({ author: "you", state: "stale", publish: "queued" })), "[you · stale] [queued ↑]");
  assert.equal(prefix(thread({ state: "addressed", commits: ["3f2a1c9e00"] })), "[addressed 3f2a1c]");
  assert.equal(prefix(thread({ publish: "published" })), "[agent · draft] [published ✓]");
});

test("teammate mode hides make changes, local mode hides PR comment", () => {
  assert.deepEqual(availableActions(thread(), "teammate"), ["send", "queue", "reply", "dismiss"]);
  assert.deepEqual(availableActions(thread(), "local"), ["send", "make-changes", "reply", "dismiss"]);
  assert.deepEqual(availableActions(thread({ state: "dismissed" }), "own"), []);
  assert.equal(footer(thread({ publish: "queued" }), "own", keyFor), "─ S send · i make changes · p remove PR comment · R reply · x dismiss");
});

test("note puts the first line in the summary and the rest plus footer in the rationale", () => {
  const n = noteFor(thread({ state: "stale", endLine: 12 }), "own", keyFor);
  assert.equal(n.summary, "[agent · stale] First line");
  assert.deepEqual(n.rationale.split("\n"), [
    "more detail",
    "was: const x = 1;",
    "lines 10–12",
    "─ S send · i make changes · p add PR comment · R reply · x dismiss",
  ]);
  assert.equal(n.line, 10);
});

test("threadAt prefers the active thread, then the narrowest range", () => {
  const wide = thread({ id: "1", startLine: 5, endLine: 15 });
  const narrow = thread({ id: "2", startLine: 10, endLine: 10 });
  assert.equal(threadAt([wide, narrow], "src/a.ts", "new", 10)?.id, "2");
  assert.equal(threadAt([wide, narrow], "src/a.ts", "new", 10, "1")?.id, "1");
  assert.equal(threadAt([wide, narrow], "src/a.ts", "old", 10), null);
  assert.equal(threadAt([thread({ state: "dismissed" })], "src/a.ts", "new", 10), null);
});

test("filterPrs matches all terms and orders by group", () => {
  const pr = (number: number, group: PrListItem["group"], title: string): PrListItem => ({
    number, group, title, author: "a", headRef: "h", updatedAt: "", worktree: null, openThreads: 0,
  });
  const items = [pr(1, "other", "docs fix"), pr(2, "mine", "fix parser"), pr(3, "review-requested", "add mul")];
  assert.deepEqual(filterPrs(items, "").map((p) => p.number), [3, 2, 1]);
  assert.deepEqual(filterPrs(items, "fix").map((p) => p.number), [2, 1]);
  assert.deepEqual(filterPrs(items, "#2 fix").map((p) => p.number), [2]);
});

test("wrap breaks on words and splits long words", () => {
  assert.deepEqual(wrap("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
  assert.deepEqual(wrap("abcdefghij", 8), ["abcdefgh", "ij"]);
});
