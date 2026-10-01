import { readStore, updateStore } from "./store.ts";
import type { DeskEvent, Thread } from "./types.ts";

export interface WaitResult {
  events: DeskEvent[];
  threads: Thread[];
}

export interface WaitOptions {
  timeoutMs: number;
  pollMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function consume(storePath: string): WaitResult {
  return updateStore(storePath, (store) => {
    const events = store.events.filter((e) => !e.consumed);
    for (const event of events) event.consumed = true;
    const ids = new Set(events.map((e) => e.threadId));
    return { events, threads: store.threads.filter((t) => ids.has(t.id)) };
  });
}

export async function waitForEvents(storePath: string, opts: WaitOptions): Promise<WaitResult> {
  const deadline = opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : Infinity;
  for (;;) {
    const pending = readStore(storePath)?.events.some((e) => !e.consumed);
    if (pending) {
      const result = consume(storePath);
      if (result.events.length > 0) return result;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { events: [], threads: [] };
    await sleep(Math.min(opts.pollMs, remaining));
  }
}
