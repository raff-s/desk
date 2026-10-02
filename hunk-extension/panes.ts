import { createElement as h, useEffect, useRef, type ReactNode } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ExtensionPaneProps, ExtensionPaneTheme } from "hunkdiff/extension";
import type { Thread } from "../src/core/types.ts";
import { actionLabel, availableActions, clip, PR_GROUPS, prefix, threadAt, wrap, type ThreadAction } from "./format.ts";
import { filteredPrs, mode, useDeskState, visibleThreads, type DeskState } from "./state.ts";

export const MODE_KEYS: Record<ThreadAction, string> = {
  send: "s",
  "queue-changes": "m",
  queue: "p",
  reply: "r",
  dismiss: "x",
};

let reportedKeybindings: ExtensionPaneProps["keybindings"] | null = null;

export function paneKeybindings(): ExtensionPaneProps["keybindings"] | null {
  return reportedKeybindings;
}

function line(key: string, content: string, fg: string, bg: string, onMouseDown?: () => void): ReactNode {
  return h("text", { key, content, style: { fg, bg }, onMouseDown });
}

function frame(theme: ExtensionPaneTheme, scrollRef: { current: ScrollBoxRenderable | null }, children: ReactNode[]): ReactNode {
  return h(
    "scrollbox",
    {
      ref: scrollRef,
      width: "100%",
      height: "100%",
      focused: false,
      scrollY: true,
      rootOptions: { backgroundColor: theme.panel },
      wrapperOptions: { backgroundColor: theme.panel },
      viewportOptions: { backgroundColor: theme.panel },
      contentOptions: { backgroundColor: theme.panel },
      verticalScrollbarOptions: { visible: false },
      horizontalScrollbarOptions: { visible: false },
    },
    h("box", { style: { width: "100%", flexDirection: "column", backgroundColor: theme.panel } }, ...children),
  );
}

function stateColor(thread: Thread, theme: ExtensionPaneTheme): string {
  switch (thread.state) {
    case "stale":
      return theme.badgeRemoved;
    case "addressed":
      return theme.badgeAdded;
    case "making-changes":
    case "sent":
      return theme.accent;
    case "queued-changes":
      return theme.accentMuted;
    default:
      return theme.text;
  }
}

function header(s: DeskState): string {
  const pr = s.store?.pr;
  if (pr) return `desk · #${pr.number} ${pr.title}`;
  return s.store ? `desk · ${s.store.key}` : "desk";
}

export function ThreadsPane(props: ExtensionPaneProps): ReactNode {
  const s = useDeskState();
  const { theme, width, files, actions } = props;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const threads = visibleThreads();
  const reviewMode = mode();
  const textWidth = Math.max(width - 4, 10);

  useEffect(() => {
    reportedKeybindings = props.keybindings;
  }, [props.keybindings]);

  const selectedPath = files.find((f) => f.id === props.selectedFileId)?.path ?? null;
  const cursor =
    selectedPath && props.currentLine
      ? threadAt(threads, selectedPath, props.currentLine.side, props.currentLine.line, s.activeThreadId)
      : null;

  useEffect(() => {
    if (!s.activeThreadId) return;
    scrollRef.current?.scrollChildIntoView(`thread-${s.activeThreadId}`);
    if (!s.threadsMode) return;
    const t = threads.find((x) => x.id === s.activeThreadId);
    const file = t ? files.find((f) => f.path === t.path) : undefined;
    if (t && file) actions.revealLine(file.id, t.side, t.startLine);
  }, [s.activeThreadId, s.threadsMode]);

  const rows: ReactNode[] = [line("title", clip(` ${header(s)}`, width), theme.accent, theme.panel)];
  const queued = threads.filter((t) => t.publish === "queued").length;
  const meta = [reviewMode, `${threads.length} open`, queued ? `${queued} queued ↑` : ""];
  if (s.review?.sync) meta.push(s.review.sync);
  rows.push(line("meta", clip(` ${meta.filter(Boolean).join(" · ")}`, width), theme.muted, theme.panel));
  if (s.review?.syncDetail && s.review.sync !== "in-sync") {
    rows.push(line("syncd", clip(` ${s.review.syncDetail}`, width), theme.muted, theme.panel));
  }
  if (s.busy) rows.push(line("busy", clip(` ${s.busy}`, width), theme.accentMuted, theme.panel));
  if (s.error) rows.push(line("err", clip(` ${s.error}`, width), theme.badgeRemoved, theme.panel));
  rows.push(line("gap", "", theme.text, theme.panel));

  if (!s.store) {
    rows.push(line("empty", " No desk review loaded. Pick a PR (L).", theme.muted, theme.panel));
  } else if (threads.length === 0) {
    rows.push(line("none", " No threads yet. c comments on a line.", theme.muted, theme.panel));
  }

  for (const t of threads) {
    const active = t.id === s.activeThreadId;
    const bg = active ? theme.selectedHunk : theme.panel;
    const mark = active ? "▸" : t.id === cursor?.id ? "◆" : " ";
    const range = t.endLine > t.startLine ? `${t.startLine}-${t.endLine}` : `${t.startLine}`;
    const side = t.side === "old" ? " (old)" : "";
    const children: ReactNode[] = [
      line("loc", clip(`${mark}${t.path}:${range}${side}`, width), theme.text, bg),
      line("tag", clip(`  ${prefix(t)}`, width), stateColor(t, theme), bg),
    ];
    t.messages.forEach((m, i) => {
      wrap(`${m.author}: ${m.body}`, textWidth).forEach((l, j) =>
        children.push(line(`m${i}-${j}`, `  ${l}`, m.author === "agent" ? theme.accentMuted : theme.muted, bg)),
      );
    });
    if (s.unmirrored[t.id]) children.push(line("unm", clip(`  ⚠ not shown inline: ${s.unmirrored[t.id]}`, width), theme.badgeRemoved, bg));
    if (active) {
      const acts = availableActions(t, reviewMode).map((a) => `${MODE_KEYS[a]} ${actionLabel(t, a)}`);
      wrap(acts.join(" · "), textWidth).forEach((l, j) => children.push(line(`a${j}`, `  ${l}`, theme.accent, bg)));
    }
    children.push(line("sp", "", theme.text, theme.panel));
    rows.push(
      h(
        "box",
        {
          key: t.id,
          id: `thread-${t.id}`,
          style: { flexDirection: "column", backgroundColor: bg },
          onMouseDown: () => {
            const file = files.find((f) => f.path === t.path);
            if (file) actions.revealLine(file.id, t.side, t.startLine);
          },
        },
        ...children,
      ),
    );
  }

  const help = s.threadsMode
    ? " j/k move · m queue · M send all · s p r x act · P publish · esc back"
    : " T threads · M send queued changes · L PRs · P publish";
  rows.push(line("help", clip(help, width), theme.muted, theme.panel));
  return frame(theme, scrollRef, rows);
}

export function PrsPane(props: ExtensionPaneProps): ReactNode {
  const s = useDeskState();
  const { theme, width } = props;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const prs = filteredPrs();
  const current = s.store?.pr?.number ?? null;

  useEffect(() => {
    const pr = prs[s.prIndex];
    if (pr) scrollRef.current?.scrollChildIntoView(`pr-${pr.number}`);
  }, [s.prIndex, s.prFilter, prs.length]);

  const rows: ReactNode[] = [line("title", " Pull requests", theme.accent, theme.panel)];
  const cursor = s.prsMode ? "▏" : "";
  rows.push(line("filter", clip(` filter: ${s.prFilter}${cursor}`, width), s.prsMode ? theme.text : theme.muted, theme.panel));
  if (s.busy) rows.push(line("busy", clip(` ${s.busy}`, width), theme.accentMuted, theme.panel));

  if (s.prs.phase === "loading" && s.prs.items.length === 0) rows.push(line("loading", " Loading…", theme.muted, theme.panel));
  if (s.prs.phase === "error") rows.push(line("error", clip(` ${s.prs.message ?? "failed"}`, width), theme.badgeRemoved, theme.panel));
  if (s.prs.phase === "ready" && prs.length === 0) rows.push(line("none", " No matching PRs", theme.muted, theme.panel));

  for (const g of PR_GROUPS) {
    const items = prs.filter((p) => p.group === g.group);
    if (items.length === 0) continue;
    rows.push(line(`g-${g.group}`, "", theme.text, theme.panel));
    rows.push(line(`gt-${g.group}`, ` ${g.title}`, theme.muted, theme.panel));
    for (const pr of items) {
      const idx = prs.indexOf(pr);
      const selected = idx === s.prIndex;
      const bg = selected ? theme.selectedHunk : theme.panel;
      const badges = [pr.worktree ? "●" : "", pr.openThreads ? `${pr.openThreads}✎` : "", pr.number === current ? "◀" : ""]
        .filter(Boolean)
        .join(" ");
      rows.push(
        h(
          "box",
          { key: pr.number, id: `pr-${pr.number}`, style: { flexDirection: "column", backgroundColor: bg } },
          line("t", clip(`${selected ? "▸" : " "}#${pr.number} ${pr.title}`, width), theme.text, bg),
          line("a", clip(`   ${pr.author} · ${pr.headRef}${badges ? `  ${badges}` : ""}`, width), theme.muted, bg),
        ),
      );
    }
  }
  rows.push(line("sp", "", theme.text, theme.panel));
  const help = s.prsMode ? " type filter · ↑↓ move · enter open · tab threads · esc back" : " L focus · ● has worktree";
  rows.push(line("help", clip(help, width), theme.muted, theme.panel));
  return frame(theme, scrollRef, rows);
}
