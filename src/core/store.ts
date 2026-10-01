import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fail } from "./errors.ts";
import type { Store } from "./types.ts";

export interface LockOptions {
  timeoutMs: number;
  staleMs: number;
}

const DEFAULT_LOCK: LockOptions = { timeoutMs: 5000, staleMs: 30000 };

export const storeDir = (commonDir: string) => join(commonDir, "desk");
export const storePathFor = (commonDir: string, key: string) => join(storeDir(commonDir), `${key}.json`);

export function sanitizeBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export const localKey = (branch: string) => `local-${sanitizeBranch(branch)}`;
export const prKey = (number: number) => `pr-${number}`;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock<T>(file: string, fn: () => T, opts: LockOptions = DEFAULT_LOCK): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (breakIfStale(lock, opts.staleMs)) continue;
      if (Date.now() >= deadline) fail(`Timed out waiting for lock ${basename(lock)}`);
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function breakIfStale(lock: string, staleMs: number): boolean {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= staleMs) return false;
    rmdirSync(lock);
    return true;
  } catch {
    return true;
  }
}

export function readStore(file: string): Store | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Store;
}

export function writeStoreAtomic(file: string, store: Store): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmp, file);
}

export function updateStore<T>(
  file: string,
  fn: (store: Store) => T,
  init?: () => Store,
  lock?: LockOptions,
): T {
  return withLock(
    file,
    () => {
      const store = readStore(file) ?? init?.() ?? fail(`No desk review at ${file}; run desk prepare first`);
      const before = JSON.stringify(store);
      const result = fn(store);
      if (JSON.stringify(store) !== before) writeStoreAtomic(file, store);
      return result;
    },
    lock,
  );
}

export function listStores(commonDir: string): { file: string; store: Store }[] {
  const dir = storeDir(commonDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .flatMap((file) => {
      try {
        const store = readStore(file);
        return store ? [{ file, store }] : [];
      } catch {
        return [];
      }
    });
}

export function emptyStore(key: string): Store {
  return {
    version: 1,
    key,
    pr: null,
    mode: "local",
    worktree: "",
    baseOid: "",
    nextThread: 1,
    nextEvent: 1,
    threads: [],
    events: [],
  };
}
