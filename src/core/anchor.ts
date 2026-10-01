import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./errors.ts";
import { fileAtRev, git, headOid } from "./git.ts";
import type { Anchor, Side, Store, Thread } from "./types.ts";

const CONTEXT = 3;

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function readSideLines(store: Store, side: Side, path: string): string[] | null {
  if (side === "old") {
    const text = fileAtRev(store.worktree, store.baseOid, path);
    return text === null ? null : splitLines(text);
  }
  const abs = join(store.worktree, path);
  return existsSync(abs) ? splitLines(readFileSync(abs, "utf8")) : null;
}

export const fingerprint = (snippet: string[]) =>
  createHash("sha1").update(snippet.join("\n")).digest("hex");

function currentCommit(store: Store): string {
  try {
    return headOid(store.worktree);
  } catch {
    return "";
  }
}

function anchorFrom(lines: string[], start: number, end: number, commit: string): Anchor {
  const snippet = lines.slice(start - 1, end);
  return {
    commit,
    fingerprint: fingerprint(snippet),
    snippet,
    before: lines.slice(Math.max(0, start - 1 - CONTEXT), start - 1),
    after: lines.slice(end, end + CONTEXT),
  };
}

export function makeAnchor(store: Store, path: string, side: Side, start: number, end: number): Anchor {
  const lines = readSideLines(store, side, path);
  if (!lines) fail(`${path} does not exist on the ${side} side`);
  if (start < 1 || end < start || end > lines.length) {
    fail(`Lines ${start}-${end} are outside ${path} (${lines.length} lines, ${side} side)`);
  }
  return anchorFrom(lines, start, end, currentCommit(store));
}

export function emptyAnchor(store: Store): Anchor {
  return { commit: currentCommit(store), fingerprint: fingerprint([]), snippet: [], before: [], after: [] };
}

function findOccurrences(lines: string[], snippet: string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i + snippet.length <= lines.length; i++) {
    if (snippet.every((line, k) => lines[i + k] === line)) hits.push(i);
  }
  return hits;
}

function contextScore(lines: string[], at: number, length: number, anchor: Anchor): number {
  let score = 0;
  anchor.before.forEach((line, k) => {
    if (lines[at - (anchor.before.length - k)] === line) score++;
  });
  anchor.after.forEach((line, k) => {
    if (lines[at + length + k] === line) score++;
  });
  return score;
}

function bestOccurrence(lines: string[], thread: Thread): number | null {
  const hits = findOccurrences(lines, thread.anchor.snippet);
  if (hits.length === 0) return null;
  const length = thread.anchor.snippet.length;
  const dist = (at: number) => Math.abs(at + 1 - thread.startLine);
  return hits.reduce((best, at) => {
    if (dist(at) !== dist(best)) return dist(at) < dist(best) ? at : best;
    return contextScore(lines, at, length, thread.anchor) > contextScore(lines, best, length, thread.anchor)
      ? at
      : best;
  });
}

function commitTouched(store: Store, thread: Thread): boolean {
  return thread.commits.some((sha) => {
    try {
      const files = git(store.worktree, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]);
      return files.split("\n").includes(thread.path);
    } catch {
      return false;
    }
  });
}

function isTracked(thread: Thread): boolean {
  if (thread.state === "dismissed" || thread.side === "old") return false;
  return !(thread.publish === "published" && (thread.state === "draft" || thread.state === "sent"));
}

function reanchorThread(store: Store, thread: Thread, lines: string[] | null): boolean {
  if (thread.anchor.snippet.length === 0) return false;
  const at = lines ? bestOccurrence(lines, thread) : null;
  const before = JSON.stringify([thread.state, thread.startLine, thread.endLine]);

  if (lines && at !== null) {
    const length = thread.anchor.snippet.length;
    thread.startLine = at + 1;
    thread.endLine = at + length;
    thread.anchor = anchorFrom(lines, at + 1, at + length, currentCommit(store));
  } else if (
    (thread.state === "making-changes" || thread.state === "addressed") &&
    commitTouched(store, thread)
  ) {
    thread.state = "addressed";
  } else {
    thread.state = "stale";
  }
  return before !== JSON.stringify([thread.state, thread.startLine, thread.endLine]);
}

export function reanchor(store: Store): Thread[] {
  const changed: Thread[] = [];
  const cache = new Map<string, string[] | null>();
  for (const thread of store.threads) {
    if (!isTracked(thread)) continue;
    if (!cache.has(thread.path)) cache.set(thread.path, readSideLines(store, "new", thread.path));
    if (reanchorThread(store, thread, cache.get(thread.path) ?? null)) {
      thread.updatedAt = new Date().toISOString();
      changed.push(thread);
    }
  }
  return changed;
}

export function rebaseAnchorOnCurrentText(store: Store, thread: Thread): void {
  const lines = readSideLines(store, thread.side, thread.path);
  if (!lines) return;
  const end = Math.min(thread.endLine, lines.length);
  const start = Math.min(thread.startLine, end);
  if (end < 1) return;
  thread.startLine = start;
  thread.endLine = end;
  thread.anchor = anchorFrom(lines, start, end, currentCommit(store));
}
