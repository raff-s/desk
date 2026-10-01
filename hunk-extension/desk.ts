import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Store } from "../src/core/types.ts";
import { runProcess } from "./session.ts";

export interface ActiveStore {
  key: string;
  storePath: string;
}

export function deskBin(): string {
  return process.env.DESK_BIN || fileURLToPath(new URL("../bin/desk.ts", import.meta.url));
}

export class Desk {
  active: ActiveStore | null = null;
  cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, DESK_BIN: deskBin() };
    if (this.active) {
      env.DESK_KEY = this.active.key;
      env.DESK_STORE = this.active.storePath;
    }
    return env;
  }

  async run<T>(args: readonly string[]): Promise<T> {
    const r = await runProcess("node", [deskBin(), ...args, "--json"], { cwd: this.cwd, env: this.env() });
    let parsed: unknown = null;
    try {
      parsed = r.stdout.trim() ? JSON.parse(r.stdout) : null;
    } catch {
      parsed = null;
    }
    if (r.code !== 0) {
      const err = parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : "";
      throw new Error(err || r.stderr.trim().split("\n")[0] || `desk ${args[0]} exited ${r.code}`);
    }
    return parsed as T;
  }

  async resolve(): Promise<ActiveStore> {
    const { DESK_STORE, DESK_KEY } = process.env;
    if (DESK_STORE && DESK_KEY) {
      this.active = { key: DESK_KEY, storePath: DESK_STORE };
      return this.active;
    }
    const out = await this.run<ActiveStore>(["store-path"]);
    this.switchTo(out, this.cwd);
    return out;
  }

  switchTo(store: ActiveStore, worktree: string): void {
    this.active = { key: store.key, storePath: store.storePath };
    this.cwd = worktree;
    process.env.DESK_KEY = store.key;
    process.env.DESK_STORE = store.storePath;
  }
}

export class StoreWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = "";
  private path = "";
  private onChange: (store: Store | null) => void;

  constructor(onChange: (store: Store | null) => void) {
    this.onChange = onChange;
  }

  start(path: string): void {
    this.stop();
    this.path = path;
    this.last = "";
    try {
      const name = basename(path);
      this.watcher = watch(dirname(path), (_event, file) => {
        if (!file || String(file) === name) void this.check();
      });
    } catch {
      this.watcher = null;
    }
    this.timer = setInterval(() => void this.check(), 1000);
    void this.check();
  }

  async check(): Promise<void> {
    const path = this.path;
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch {
      text = "";
    }
    if (path !== this.path || text === this.last) return;
    let store: Store | null = null;
    try {
      store = text ? (JSON.parse(text) as Store) : null;
    } catch {
      return;
    }
    this.last = text;
    this.onChange(store);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
