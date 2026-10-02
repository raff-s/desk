import { spawn } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionCommandContext,
  ExtensionCommandHandler,
  ExtensionDialogs,
  ExtensionKeyEvent,
  ExtensionReviewNote,
  ExtensionReviewSelection,
  HunkExtensionAPI,
} from "hunkdiff/extension";
import type { PreparedReview, PrListItem, Side, Thread } from "../src/core/types.ts";
import { Desk, StoreWatcher } from "./desk.ts";
import { availableActions, nearestThread, noteFor, noteSignature, sortThreads, threadAt, type NoteSpec, type ThreadAction } from "./format.ts";
import { paneKeybindings, PrsPane, ThreadsPane } from "./panes.ts";
import { HunkSession, runProcess } from "./session.ts";
import {
  activeThread,
  getState,
  mode,
  movePr,
  moveActiveThread,
  selectedPr,
  update,
  visibleThreads,
} from "./state.ts";

const EXT_ID = basename(dirname(fileURLToPath(import.meta.url)));

const DEFAULT_KEYS = {
  comment: "C",
  send: "S",
  "make-changes": "i",
  queue: "p",
  reply: "A",
  dismiss: "x",
  publish: "P",
  "open-file": "o",
  "open-worktree": "O",
  threads: "T",
  prs: "L",
} as const;

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

interface Mirror {
  noteId: string;
  sig: string;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function desk(hunk: HunkExtensionAPI): void {
  const client = new Desk(process.cwd());
  const session = new HunkSession(process.cwd());
  const mirrors = new Map<string, Mirror>();
  const failed = new Map<string, string>();
  const failedReasons: Record<string, string> = {};
  let changesetReady = false;
  let syncQueue: Promise<void> = Promise.resolve();
  let lastReanchor = 0;
  let initialRoot = process.cwd();

  const watcher = new StoreWatcher((store) => {
    update({ store });
    scheduleSync();
  });

  function keyFor(action: ThreadAction): string {
    if (action === "reply") return paneKeybindings()?.getKeys("hunk.review.replyToActiveNote")[0] ?? "R";
    const kb = paneKeybindings();
    return kb ? (kb.getKeys(`${EXT_ID}.${action}`)[0] ?? "") : DEFAULT_KEYS[action];
  }

  function scheduleSync(): Promise<void> {
    syncQueue = syncQueue.then(syncNotes, syncNotes);
    return syncQueue;
  }

  async function syncNotes(): Promise<void> {
    const store = getState().store;
    const desired = new Map<string, NoteSpec>();
    if (store && changesetReady) {
      for (const t of sortThreads(store.threads)) desired.set(t.id, noteFor(t, mode(), keyFor));
    }
    for (const [id, m] of mirrors) {
      const spec = desired.get(id);
      if (spec && noteSignature(spec) === m.sig) continue;
      mirrors.delete(id);
      await session.remove(m.noteId).catch(() => undefined);
    }
    const pending = [...desired].filter(([id, spec]) => !mirrors.has(id) && failed.get(id) !== noteSignature(spec));
    if (pending.length > 0) {
      try {
        const ids = await session.apply(pending.map(([, spec]) => spec));
        pending.forEach(([id, spec], i) => {
          const noteId = ids[i];
          if (noteId) mirrors.set(id, { noteId, sig: noteSignature(spec) });
        });
      } catch {
        for (const [id, spec] of pending) {
          try {
            mirrors.set(id, { noteId: await session.add(spec), sig: noteSignature(spec) });
          } catch (e) {
            failed.set(id, noteSignature(spec));
            const msg = errText(e);
            failedReasons[id] = /No diff file matches/.test(msg) ? "file not in this diff" : msg.replace(/^hunk: /, "");
          }
        }
      }
    }
    const unmirrored: Record<string, string> = {};
    for (const id of desired.keys()) if (!mirrors.has(id) && failedReasons[id]) unmirrored[id] = failedReasons[id]!;
    update({ unmirrored });
  }

  async function reconcileAfterReload(): Promise<void> {
    failed.clear();
    for (const k of Object.keys(failedReasons)) delete failedReasons[k];
    try {
      const live = new Set((await session.list()).map((n) => n.noteId));
      for (const [id, m] of mirrors) if (!live.has(m.noteId)) mirrors.delete(id);
    } catch {
      mirrors.clear();
    }
  }

  async function reanchor(): Promise<void> {
    if (!client.active || Date.now() - lastReanchor < 1000) return;
    lastReanchor = Date.now();
    try {
      await client.runOnReview(["reanchor"]);
    } catch (e) {
      hunk.log(`reanchor failed: ${errText(e)}`);
    }
  }

  async function withinRoot(path: string): Promise<boolean> {
    const target = await realpath(path).catch(() => path);
    const rel = relative(initialRoot, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  async function start(): Promise<void> {
    const top = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() }).catch(() => null);
    if (top?.code === 0) initialRoot = await realpath(top.stdout.trim()).catch(() => top.stdout.trim());
    try {
      const active = await client.resolve();
      update({ storePath: active.storePath, error: null });
      watcher.start(active.storePath);
      if (changesetReady) await reanchor();
    } catch (e) {
      update({ error: `desk: ${errText(e)}` });
    }
  }

  async function act(thread: Thread, action: string, notify: Notify, body?: string): Promise<boolean> {
    try {
      await client.runOnReview(["action", thread.id, action, ...(body ? ["--body", body] : [])]);
      return true;
    } catch (e) {
      notify(`desk ${action}: ${errText(e)}`, "error");
      return false;
    }
  }

  async function runAction(thread: Thread, action: ThreadAction, notify: Notify): Promise<void> {
    if (action === "make-changes" && mode() === "teammate") {
      notify("Make changes is not available on a teammate's PR", "warning");
      return;
    }
    if (!availableActions(thread, mode()).includes(action)) {
      notify(`Can't ${action} a ${thread.state} thread`, "warning");
      return;
    }
    if (action === "queue") {
      const next = thread.publish === "queued" ? "unqueue" : "queue";
      if (await act(thread, next, notify)) notify(next === "queue" ? `#${thread.id} queued for the PR ↑` : `#${thread.id} unqueued`);
      return;
    }
    if (await act(thread, action, notify)) {
      const done: Record<string, string> = { send: "sent to agent", "make-changes": "agent asked to make changes", dismiss: "dismissed" };
      notify(`#${thread.id} ${done[action] ?? action}`);
    }
  }

  async function reply(thread: Thread, body: string, dialogs: ExtensionDialogs, notify: Notify): Promise<void> {
    const options = ["Reply"];
    if (thread.state === "draft" || thread.state === "stale") options.push("Reply and send to agent");
    if (mode() !== "teammate") options.push("Reply and make changes");
    if (thread.state === "sent" || thread.state === "addressed") options[0] = "Reply (agent is notified)";
    const choice = options.length > 1 ? await dialogs.select({ title: `Reply on #${thread.id}`, options }) : options[0];
    if (choice === null) {
      notify("Reply discarded", "warning");
      return;
    }
    try {
      await client.runOnReview(["reply", thread.id, "--body", body, "--author", "you"]);
    } catch (e) {
      notify(`desk reply: ${errText(e)}`, "error");
      return;
    }
    if (choice === "Reply and send to agent") await act(thread, "send", notify);
    else if (choice === "Reply and make changes") await act(thread, "make-changes", notify, body);
    notify(`Replied on #${thread.id}`);
  }

  async function publish(dialogs: ExtensionDialogs, notify: Notify): Promise<void> {
    if (mode() === "local") {
      notify("Nothing to publish: this review has no PR", "warning");
      return;
    }
    const queued = visibleThreads().filter((t) => t.publish === "queued").length;
    const choice = await dialogs.select({
      title: `Publish review (${queued} queued comment${queued === 1 ? "" : "s"})`,
      options: ["Comment", "Approve", "Request changes"],
    });
    if (choice === null) return;
    const event = { Comment: "COMMENT", Approve: "APPROVE", "Request changes": "REQUEST_CHANGES" }[choice] ?? "COMMENT";
    const body = await dialogs.input({ title: `${choice}: review body (optional, Enter to skip)`, placeholder: "Top-level review comment" });
    if (body === null) return;
    update({ busy: "Publishing…" });
    try {
      const out = await client.runOnReview<{ reviewUrl: string; published: string[] }>([
        "publish",
        "--yes",
        "--event",
        event,
        ...(body.trim() ? ["--body", body.trim()] : []),
      ]);
      notify(`Published ${out.published.length} comment(s): ${out.reviewUrl}`);
    } catch (e) {
      notify(`desk publish: ${errText(e)}`, "error");
    } finally {
      update({ busy: null });
    }
  }

  function selectionThread(sel: ExtensionReviewSelection): Thread | null {
    const threads = visibleThreads();
    if (sel.file && sel.currentLine) {
      const t = threadAt(threads, sel.file.path, sel.currentLine.side, sel.currentLine.line, getState().activeThreadId);
      if (t) return t;
    }
    if (sel.file && sel.hunkIndex !== null) {
      const hunk = sel.file.hunks?.[sel.hunkIndex];
      const t = nearestThread(threads, sel.file.path, hunk?.newRange ?? null);
      if (t) return t;
    }
    return activeThread();
  }

  function withThread(sel: ExtensionReviewSelection | null, notify: Notify): Thread | null {
    if (!getState().store) {
      notify("No desk review loaded", "warning");
      return null;
    }
    const t = sel ? selectionThread(sel) : activeThread();
    if (!t) notify("No thread here. Move to a commented line or pick one in the threads pane (T).", "warning");
    return t;
  }

  function openInCursor(args: string[], notify: Notify): void {
    try {
      const child = spawn("cursor", args, { detached: true, stdio: "ignore" });
      child.on("error", (e) => notify(`cursor: ${errText(e)}`, "error"));
      child.unref();
    } catch (e) {
      notify(`cursor: ${errText(e)}`, "error");
    }
  }

  function worktree(): string {
    return getState().store?.worktree ?? client.cwd;
  }

  function openThreadInCursor(thread: Thread, notify: Notify): void {
    openInCursor(["-g", `${join(worktree(), thread.path)}:${thread.startLine}`], notify);
  }

  async function loadPrs(): Promise<void> {
    update({ prs: { ...getState().prs, phase: "loading" } });
    try {
      const items = await client.run<PrListItem[]>(["prs"]);
      const cur = getState().store?.pr?.number;
      const idx = Math.max(0, items.findIndex((p) => p.number === cur));
      update({ prs: { phase: "ready", items }, prIndex: getState().prFilter ? 0 : idx });
    } catch (e) {
      update({ prs: { phase: "error", items: [], message: errText(e) } });
    }
  }

  async function openElsewhere(pr: PrListItem, review: PreparedReview, notify: Notify, quit: () => boolean): Promise<void> {
    const handoff = process.env.DESK_HANDOFF;
    if (handoff) {
      await writeFile(handoff, JSON.stringify(review));
      notify(`Reopening on #${pr.number}…`);
      if (!quit()) notify("Couldn't quit Hunk to hand off; press q", "warning");
      return;
    }
    update({ busy: `Opening #${pr.number} in a new tab…` });
    const out = await client.run<{ tab: { via: string; detail: string } }>(["launch", String(pr.number)]);
    notify(
      out.tab.via === "print"
        ? `#${pr.number} lives in another worktree; run: ${out.tab.detail}`
        : `#${pr.number} opened in a new ${out.tab.via} tab (Hunk can't repoint this window outside ${initialRoot})`,
    );
  }

  async function openPr(pr: PrListItem, notify: Notify, quit: () => boolean): Promise<void> {
    if (getState().busy) return;
    const t0 = Date.now();
    update({ busy: `Preparing #${pr.number}…` });
    try {
      const review = await client.run<PreparedReview>(["prepare", String(pr.number)]);
      const t1 = Date.now();
      if (!(await withinRoot(review.worktree))) {
        await openElsewhere(pr, review, notify, quit);
        return;
      }
      update({ busy: `Opening #${pr.number} in ${review.worktree}…` });
      changesetReady = false;
      await scheduleSync();
      client.switchTo(review, review.worktree);
      session.worktree = review.worktree;
      update({ review, store: null, storePath: review.storePath, activeThreadId: null, error: null });
      watcher.start(review.storePath);
      lastReanchor = 0;
      await session.reload(review.worktree, review.baseOid);
      const t2 = Date.now();
      notify(
        `#${pr.number} open (${review.mode}, ${review.sync}) in ${((t2 - t0) / 1000).toFixed(1)}s: prepare ${((t1 - t0) / 1000).toFixed(1)}s, reload ${((t2 - t1) / 1000).toFixed(1)}s`,
      );
      hunk.log(`open #${pr.number}: prepare ${t1 - t0}ms reload ${t2 - t1}ms`);
    } catch (e) {
      notify(`Couldn't open #${pr.number}: ${errText(e)}`, "error");
    } finally {
      changesetReady = true;
      void scheduleSync();
      update({ busy: null });
    }
  }

  async function convertUserNote(note: ExtensionReviewNote, dialogs: ExtensionDialogs, notify: Notify): Promise<void> {
    const body = note.body.trim();
    if (note.draft || !body || !getState().store) return;
    if (note.parentId) {
      const threadId = [...mirrors].find(([, m]) => m.noteId === note.parentId)?.[0];
      const thread = visibleThreads().find((t) => t.id === threadId);
      if (!thread) return;
      await session.remove(note.id).catch(() => undefined);
      await reply(thread, body, dialogs, notify);
      return;
    }
    const range = note.side === "old" ? note.oldRange : note.newRange;
    const start = range?.[0] ?? note.line;
    const end = range?.[1] ?? start;
    try {
      const t = await client.runOnReview<Thread>([
        "comment",
        "add",
        "--file",
        note.filePath,
        "--line",
        String(start),
        ...(end > start ? ["--end-line", String(end)] : []),
        "--side",
        note.side,
        "--body",
        body,
        "--author",
        "you",
      ]);
      await session.remove(note.id).catch(() => undefined);
      update({ activeThreadId: t.id });
      notify(`Draft #${t.id} saved. ${keyFor("send")} sends it to the agent.`);
    } catch (e) {
      notify(`desk comment: ${errText(e)} (kept as a plain Hunk note)`, "error");
    }
  }

  async function newComment(sel: ExtensionReviewSelection, dialogs: ExtensionDialogs, notify: Notify): Promise<void> {
    if (!getState().store) {
      notify("No desk review loaded", "warning");
      return;
    }
    const file = sel.file;
    const hunkRange = file && sel.hunkIndex !== null ? file.hunks?.[sel.hunkIndex]?.newRange : undefined;
    const target: { side: Side; line: number } | null = sel.currentLine ?? (hunkRange ? { side: "new", line: hunkRange[0] } : null);
    if (!file || !target) {
      notify("Move to a line first", "warning");
      return;
    }
    const body = await dialogs.input({ title: `Comment on ${file.path}:${target.line}`, placeholder: "Your comment" });
    if (!body?.trim()) return;
    try {
      const t = await client.runOnReview<Thread>([
        "comment", "add", "--file", file.path, "--line", String(target.line), "--side", target.side, "--body", body.trim(), "--author", "you",
      ]);
      update({ activeThreadId: t.id });
      notify(`Draft #${t.id} saved`);
    } catch (e) {
      notify(`desk comment: ${errText(e)}`, "error");
    }
  }

  function keyChar(key: ExtensionKeyEvent): string {
    if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") return key.sequence;
    return key.name ?? "";
  }

  hunk.registerPane({
    id: "threads",
    title: "desk threads",
    placement: "right",
    defaultOpen: true,
    currentLine: true,
    width: { preferred: 48, min: 30, fraction: 0.28 },
    component: ThreadsPane,
  });

  hunk.registerPane({
    id: "prs",
    title: "desk PRs",
    placement: "left",
    defaultOpen: !process.env.DESK_STORE,
    width: { preferred: 40, min: 26, fraction: 0.22 },
    component: PrsPane,
  });

  hunk.registerKeyboardMode({
    id: "threads",
    title: "desk threads",
    onEnter: () => update({ threadsMode: true }),
    onExit: () => update({ threadsMode: false }),
    onKey: (key, ctx) => {
      const ch = keyChar(key);
      const t = activeThread();
      const thread = (action: ThreadAction): "handled" => {
        if (t) void runAction(t, action, ctx.notify);
        else ctx.notify("No thread selected", "warning");
        return "handled";
      };
      switch (ch) {
        case "j":
        case "down":
          moveActiveThread(1);
          return "handled";
        case "k":
        case "up":
          moveActiveThread(-1);
          return "handled";
        case "return":
        case "enter":
        case "t":
        case "q":
          return "exit";
        case "s":
          return thread("send");
        case "m":
          return thread("make-changes");
        case "p":
          return thread("queue");
        case "x":
          return thread("dismiss");
        case "r":
          if (t) hunk.events.emit("desk:reply", { threadId: t.id });
          return "handled";
        case "P":
          hunk.events.emit("desk:publish", {});
          return "handled";
        case "o":
          if (t) openThreadInCursor(t, ctx.notify);
          return "handled";
        case "O":
          openInCursor([worktree()], ctx.notify);
          return "handled";
        case "g":
          hunk.events.emit("desk:focus-prs", {});
          ctx.keyboardModes.enterMode("prs");
          return "handled";
        default:
          return "pass";
      }
    },
  });

  hunk.registerKeyboardMode({
    id: "prs",
    title: "desk PRs",
    onEnter: () => update({ prsMode: true }),
    onExit: () => {
      update({ prsMode: false });
      hunk.events.emit("desk:close-prs", {});
    },
    onKey: (key, ctx) => {
      const name = key.name ?? "";
      if (getState().busy) return "handled";
      if (name === "up" || (key.ctrl && (name === "p" || name === "k"))) {
        movePr(-1);
        return "handled";
      }
      if (name === "down" || (key.ctrl && (name === "n" || name === "j"))) {
        movePr(1);
        return "handled";
      }
      if (name === "return" || name === "enter") {
        const pr = selectedPr();
        if (!pr) return "handled";
        void openPr(pr, ctx.notify, () => ctx.commands.execute("hunk.app.quit")).finally(() => ctx.keyboardModes.exitMode());
        return "handled";
      }
      if (name === "tab") {
        hunk.events.emit("desk:focus-threads", {});
        if (!activeThread() && visibleThreads()[0]) update({ activeThreadId: visibleThreads()[0]!.id });
        ctx.keyboardModes.enterMode("threads");
        return "handled";
      }
      if (key.ctrl && name === "r") {
        void loadPrs();
        return "handled";
      }
      if (name === "backspace") {
        update({ prFilter: getState().prFilter.slice(0, -1), prIndex: 0 });
        return "handled";
      }
      const ch = keyChar(key);
      if (!key.ctrl && !key.meta && ch.length === 1) {
        update({ prFilter: getState().prFilter + ch, prIndex: 0 });
        return "handled";
      }
      return "pass";
    },
  });

  hunk.events.on<{ threadId: string }>("desk:reply", async ({ threadId }, ctx) => {
    const t = visibleThreads().find((x) => x.id === threadId);
    if (!t) return;
    const body = await ctx.dialogs.input({ title: `Reply on #${t.id} ${t.path}:${t.startLine}`, placeholder: "Your reply" });
    if (body?.trim()) await reply(t, body.trim(), ctx.dialogs, ctx.notify);
  });
  hunk.events.on("desk:publish", (_p, ctx) => publish(ctx.dialogs, ctx.notify));

  const commands: { id: string; title: string; run: ExtensionCommandHandler }[] = [
    { id: "comment", title: "desk: new comment on this line", run: (ctx) => newComment(ctx.selection, ctx.dialogs, ctx.notify) },
    ...(["send", "make-changes", "queue", "dismiss"] as const).map((action) => ({
      id: action,
      title: `desk: ${action === "queue" ? "add/remove PR comment" : action.replace("-", " ")}`,
      run: (ctx: ExtensionCommandContext) => {
        if (action === "make-changes" && mode() === "teammate") {
          ctx.notify("Make changes is not available on a teammate's PR", "warning");
          return;
        }
        const t = withThread(ctx.selection, ctx.notify);
        if (t) return runAction(t, action, ctx.notify);
      },
    })),
    {
      id: "reply",
      title: "desk: reply to thread",
      run: async (ctx) => {
        const t = withThread(ctx.selection, ctx.notify);
        if (!t) return;
        const body = await ctx.dialogs.input({ title: `Reply on #${t.id} ${t.path}:${t.startLine}`, placeholder: "Your reply" });
        if (body?.trim()) await reply(t, body.trim(), ctx.dialogs, ctx.notify);
      },
    },
    { id: "publish", title: "desk: publish review", run: (ctx) => publish(ctx.dialogs, ctx.notify) },
    {
      id: "open-file",
      title: "desk: open line in Cursor",
      run: (ctx) => {
        const { file, currentLine } = ctx.selection;
        if (file) openInCursor(["-g", `${join(worktree(), file.path)}:${currentLine?.line ?? 1}`], ctx.notify);
        else ctx.notify("No file selected", "warning");
      },
    },
    { id: "open-worktree", title: "desk: open worktree in Cursor", run: (ctx) => openInCursor([worktree()], ctx.notify) },
    {
      id: "threads",
      title: "desk: focus threads pane",
      run: (ctx) => {
        ctx.panes.open("threads");
        const t = selectionThread(ctx.selection) ?? visibleThreads()[0];
        if (t) update({ activeThreadId: t.id });
        ctx.keyboardModes.enterMode("threads");
      },
    },
    {
      id: "prs",
      title: "desk: focus PR pane",
      run: (ctx) => {
        ctx.panes.open("prs");
        void loadPrs();
        ctx.keyboardModes.enterMode("prs");
      },
    },
    { id: "refresh-prs", title: "desk: refresh PR list", run: () => loadPrs() },
  ];
  for (const c of commands) {
    const key = c.id in DEFAULT_KEYS ? DEFAULT_KEYS[c.id as keyof typeof DEFAULT_KEYS] : undefined;
    hunk.registerCommand({ id: c.id, title: c.title, ...(key ? { key } : {}) }, c.run);
  }

  hunk.events.on("desk:focus-prs", (_p, ctx) => {
    ctx.panes.open("prs");
    void loadPrs();
  });
  hunk.events.on("desk:close-prs", (_p, ctx) => ctx.panes.close("prs"));
  hunk.events.on("desk:focus-threads", (_p, ctx) => ctx.panes.open("threads"));

  hunk.on("changeset_loaded", async () => {
    changesetReady = true;
    await reconcileAfterReload();
    await reanchor();
    await scheduleSync();
  });
  hunk.on("session_reload", async () => {
    changesetReady = true;
    await reconcileAfterReload();
    await reanchor();
    await scheduleSync();
  });
  hunk.on("note_created", ({ note }, ctx) => convertUserNote(note, ctx.dialogs, ctx.notify));
  hunk.on("shutdown", () => watcher.stop());

  void start();
}
