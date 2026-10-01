import type { PrListItem, ReviewMode, Side, Thread } from "../src/core/types.ts";

export type ThreadAction = "send" | "make-changes" | "queue" | "reply" | "dismiss";

export type KeyLookup = (action: ThreadAction) => string;

export interface NoteSpec {
  filePath: string;
  side: Side;
  line: number;
  summary: string;
  rationale: string;
  author: string;
}

export const ACTION_LABELS: Record<ThreadAction, string> = {
  send: "send",
  "make-changes": "make changes",
  queue: "add PR comment",
  reply: "reply",
  dismiss: "dismiss",
};

export function shortSha(sha: string): string {
  return sha.slice(0, 6);
}

export function stateTag(thread: Thread): string {
  switch (thread.state) {
    case "addressed": {
      const last = thread.commits[thread.commits.length - 1];
      return last ? `[addressed ${shortSha(last)}]` : "[addressed]";
    }
    case "making-changes":
      return "[making changes…]";
    default:
      return `[${thread.author} · ${thread.state}]`;
  }
}

export function publishTag(thread: Thread): string {
  if (thread.publish === "queued") return "[queued ↑]";
  if (thread.publish === "published") return "[published ✓]";
  return "";
}

export function prefix(thread: Thread): string {
  return [stateTag(thread), publishTag(thread)].filter(Boolean).join(" ");
}

export function isOpen(thread: Thread): boolean {
  return thread.state !== "dismissed";
}

export function availableActions(thread: Thread, mode: ReviewMode): ThreadAction[] {
  if (thread.state === "dismissed") return [];
  const actions: ThreadAction[] = [];
  if (thread.state === "draft" || thread.state === "stale") actions.push("send");
  if (mode !== "teammate" && thread.state !== "making-changes") actions.push("make-changes");
  if (mode !== "local" && thread.publish !== "published") actions.push("queue");
  actions.push("reply", "dismiss");
  return actions;
}

export function actionLabel(thread: Thread, action: ThreadAction): string {
  if (action === "queue" && thread.publish === "queued") return "remove PR comment";
  return ACTION_LABELS[action];
}

export function footer(thread: Thread, mode: ReviewMode, keyFor: KeyLookup): string {
  const parts = availableActions(thread, mode).map((a) => {
    const key = keyFor(a);
    return key ? `${key} ${actionLabel(thread, a)}` : actionLabel(thread, a);
  });
  return parts.length > 0 ? `─ ${parts.join(" · ")}` : "";
}

export function firstLine(text: string, max = 100): string {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function noteFor(thread: Thread, mode: ReviewMode, keyFor: KeyLookup): NoteSpec {
  const [first, ...rest] = thread.messages;
  const firstBody = first?.body ?? "";
  const lines: string[] = [];
  const firstRest = firstBody.split("\n").slice(1).join("\n").trim();
  if (firstRest) lines.push(firstRest);
  for (const m of rest) lines.push(`${m.author}: ${m.body.trim()}`);
  if (thread.state === "stale" && thread.anchor.snippet.length > 0) {
    lines.push(`was: ${firstLine(thread.anchor.snippet.join(" "), 80)}`);
  }
  if (thread.endLine > thread.startLine) lines.push(`lines ${thread.startLine}–${thread.endLine}`);
  const foot = footer(thread, mode, keyFor);
  if (foot) lines.push(foot);
  return {
    filePath: thread.path,
    side: thread.side,
    line: thread.startLine,
    summary: `${prefix(thread)} ${firstLine(firstBody)}`.trim(),
    rationale: lines.join("\n"),
    author: thread.author,
  };
}

export function noteSignature(spec: NoteSpec): string {
  return JSON.stringify(spec);
}

export function threadAt(
  threads: readonly Thread[],
  path: string,
  side: Side,
  line: number,
  preferId: string | null = null,
): Thread | null {
  const hits = threads.filter(
    (t) => isOpen(t) && t.path === path && t.side === side && line >= t.startLine && line <= t.endLine,
  );
  const preferred = hits.find((t) => t.id === preferId);
  if (preferred) return preferred;
  hits.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine) || b.updatedAt.localeCompare(a.updatedAt));
  return hits[0] ?? null;
}

export function nearestThread(
  threads: readonly Thread[],
  path: string,
  range: readonly [number, number] | null,
): Thread | null {
  const candidates = threads.filter((t) => isOpen(t) && t.path === path);
  if (!range) return candidates[0] ?? null;
  const inRange = candidates.filter((t) => t.endLine >= range[0] && t.startLine <= range[1]);
  return inRange[0] ?? null;
}

export function sortThreads(threads: readonly Thread[]): Thread[] {
  return threads
    .filter(isOpen)
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine || Number(a.id) - Number(b.id));
}

export const PR_GROUPS: readonly { group: PrListItem["group"]; title: string }[] = [
  { group: "review-requested", title: "Review requested" },
  { group: "mine", title: "Mine" },
  { group: "other", title: "Other" },
];

export function filterPrs(prs: readonly PrListItem[], filter: string): PrListItem[] {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = prs.filter((pr) => {
    const hay = `#${pr.number} ${pr.title} ${pr.author} ${pr.headRef}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const order = PR_GROUPS.map((g) => g.group);
  return matched.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(width, 8);
  for (const raw of text.split("\n")) {
    let line = "";
    for (const word of raw.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= w) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > w) {
        out.push(line.slice(0, w));
        line = line.slice(w);
      }
    }
    out.push(line);
  }
  return out;
}

export function clip(text: string, width: number): string {
  if (width <= 1) return "";
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}
