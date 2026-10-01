import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { emptyStore, readStore, updateStore, withLock, writeStoreAtomic } from "../src/core/store.ts";

const run = promisify(execFile);
const tmp = () => mkdtempSync(join(tmpdir(), "desk-store-"));

test("writeStoreAtomic leaves only the final file", () => {
  const dir = tmp();
  const file = join(dir, "pr-1.json");
  writeStoreAtomic(file, emptyStore("pr-1"));
  assert.equal(readStore(file)?.key, "pr-1");
  assert.deepEqual(readdirSync(dir), ["pr-1.json"]);
});

test("updateStore creates from init, persists changes, and discards them when fn throws", () => {
  const file = join(tmp(), "desk", "pr-2.json");
  updateStore(file, (s) => void (s.nextThread = 5), () => emptyStore("pr-2"));
  assert.equal(readStore(file)?.nextThread, 5);
  assert.throws(() => updateStore(file, (s) => {
    s.nextThread = 99;
    throw new Error("boom");
  }));
  assert.equal(readStore(file)?.nextThread, 5);
  assert.throws(() => updateStore(join(tmp(), "missing.json"), () => {}), /No desk review/);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("lock times out while held and is released afterwards", () => {
  const file = join(tmp(), "pr-3.json");
  const opts = { timeoutMs: 150, staleMs: 30000 };
  withLock(file, () => {
    assert.throws(() => withLock(file, () => {}, opts), /Timed out waiting for lock/);
  });
  assert.equal(withLock(file, () => "ok", opts), "ok");
});

test("stale locks are broken", () => {
  const dir = tmp();
  const file = join(dir, "pr-4.json");
  mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, old, old);
  assert.equal(withLock(file, () => "ok", { timeoutMs: 500, staleMs: 30000 }), "ok");
});

test("concurrent processes never lose updates", async () => {
  const file = join(tmp(), "pr-5.json");
  writeStoreAtomic(file, emptyStore("pr-5"));
  const storeUrl = new URL("../src/core/store.ts", import.meta.url).href;
  const script = `
    import { updateStore } from ${JSON.stringify(storeUrl)};
    for (let i = 0; i < 10; i++) updateStore(${JSON.stringify(file)}, (s) => { s.nextThread++; });
  `;
  await Promise.all(
    Array.from({ length: 5 }, () => run(process.execPath, ["--input-type=module", "-e", script])),
  );
  assert.equal(readStore(file)?.nextThread, 51);
  assert.deepEqual(readdirSync(join(file, "..")), ["pr-5.json"]);
});
