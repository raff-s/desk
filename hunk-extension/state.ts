import { useSyncExternalStore } from "react";
import type { PreparedReview, PrListItem, ReviewMode, Store, Thread } from "../src/core/types.ts";
import { filterPrs, sortThreads } from "./format.ts";

export interface DeskState {
  store: Store | null;
  storePath: string | null;
  error: string | null;
  review: PreparedReview | null;
  prs: { phase: "idle" | "loading" | "ready" | "error"; items: PrListItem[]; message?: string };
  prFilter: string;
  prIndex: number;
  activeThreadId: string | null;
  threadsMode: boolean;
  prsMode: boolean;
  unmirrored: Readonly<Record<string, string>>;
  busy: string | null;
}

let state: DeskState = {
  store: null,
  storePath: null,
  error: null,
  review: null,
  prs: { phase: "idle", items: [] },
  prFilter: "",
  prIndex: 0,
  activeThreadId: null,
  threadsMode: false,
  prsMode: false,
  unmirrored: {},
  busy: null,
};

const listeners = new Set<() => void>();

export function getState(): DeskState {
  return state;
}

export function update(patch: Partial<DeskState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useDeskState(): DeskState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function mode(): ReviewMode {
  return state.review?.mode ?? state.store?.mode ?? "local";
}

export function visibleThreads(): Thread[] {
  return state.store ? sortThreads(state.store.threads) : [];
}

export function activeThread(): Thread | null {
  const threads = visibleThreads();
  return threads.find((t) => t.id === state.activeThreadId) ?? null;
}

export function moveActiveThread(delta: number): void {
  const threads = visibleThreads();
  if (threads.length === 0) return;
  const cur = threads.findIndex((t) => t.id === state.activeThreadId);
  const next = cur < 0 ? (delta > 0 ? 0 : threads.length - 1) : Math.min(threads.length - 1, Math.max(0, cur + delta));
  update({ activeThreadId: threads[next]!.id });
}

export function filteredPrs(): PrListItem[] {
  return filterPrs(state.prs.items, state.prFilter);
}

export function movePr(delta: number): void {
  const n = filteredPrs().length;
  if (n === 0) return;
  update({ prIndex: Math.min(n - 1, Math.max(0, state.prIndex + delta)) });
}

export function selectedPr(): PrListItem | null {
  return filteredPrs()[state.prIndex] ?? null;
}
