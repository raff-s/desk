# desk contract

This is the shared contract between the three parts of desk:

- **core** (`bin/desk.ts`, `src/core/`): the `desk` CLI and the store. The only code that writes the store.
- **launcher** (`src/launch/`): opens a full terminal tab running a command.
- **Hunk extension** (`hunk-extension/`): the review screen. It never writes the store directly. It reads it, and changes it by running `desk … --json`.

The agent (Cursor, Claude Code, …) uses the same CLI, guided by `skills/desk/SKILL.md`.

Types live in `src/core/types.ts`. Runtime: Node 24+ running `.ts` directly (type stripping, no build). Erasable TypeScript only: no enums, no namespaces, no parameter properties. No runtime npm dependencies; shell out to `git`, `gh`, `hunk`.

## Review keys and the store file

A review is identified by a **key**:

- `pr-<number>` for a pull request review.
- `local-<branch>` for reviewing the working tree with no PR (for example `desk .` after the agent wrote code).

The store file is `<git common dir>/desk/<key>.json`, where the git common dir is `git rev-parse --git-common-dir` resolved to an absolute path. Every worktree of a repo shares it, so the main checkout and a PR worktree see the same threads.

Writes are atomic (write a temp file in the same directory, then rename) and guarded by a lock directory `<key>.json.lock` created with `mkdir`, retried for up to 5 s, with stale locks (older than 30 s) broken.

## Modes

- `own`: the PR author is the authenticated `gh` user. Make changes is allowed.
- `teammate`: anyone else's PR. Comments only. `make-changes`, `done`, and `push` are refused with a clear error. The worktree is never modified by desk except fast-forwarding to the PR head when clean.
- `local`: no PR. Make changes allowed. Publish refused.

## Thread lifecycle

`state` (local work) and `publish` (upstream) are independent.

state: `draft` → `sent` (human pressed send, or agent replied) → `making-changes` (human pressed Make changes, or replied with instructions on a thread then chose Make changes) → `addressed` (agent ran `desk done`). Any open thread → `stale` when re-anchoring finds its lines changed by something other than one of the thread's own commits. Any → `dismissed`.

publish: `none` → `queued` (Add PR comment) → `published` (after `desk publish`). `queued` → `none` (unqueue).

Agent-authored threads always start as `draft` and `publish: none`. Only `desk publish` posts to GitHub, and only threads with `publish: queued`.

## Events (human → agent)

When the human acts in the review, core appends an event to `store.events`:

- `send`: thread sent to the agent to read and reply.
- `make-changes`: the agent should change the code for this thread. `body` holds extra instructions if the human replied ("do that, but also…").
- `reply`: the human replied on a thread that is already `sent`.

`desk wait` returns unconsumed events and marks them consumed.

## Anchors and re-anchoring

A thread anchors to `path`, `side`, `startLine..endLine`. `anchor.snippet` holds those lines' text, `anchor.before`/`after` up to 3 lines of context, `anchor.fingerprint` is the sha1 of the snippet joined with `\n`, `anchor.commit` the HEAD sha when written. For `side: new`, lines are read from the working tree file. For `side: old`, from `git show <baseOid>:<path>`.

`desk reanchor` (also run inside `open`, `done`, `threads`, `sync`):

1. Skip threads that are `dismissed`, or `published` with `state` `draft`/`sent`. Old-side threads never move.
2. Search the current file for the snippet, preferring the occurrence nearest the old `startLine`; context lines break ties.
3. Snippet found unchanged → update line numbers, keep state.
4. Snippet not found, and the thread has commits whose diff touched this path → `addressed` (if it was `making-changes`) or keep `addressed`.
5. Snippet not found otherwise → `stale`. Keep the old snippet so the UI can show what the comment was about. If the file no longer exists, keep the line numbers and mark `stale`.

## Worktree resolution (`desk prepare <pr>`)

1. `gh pr view <n> --json number,title,url,author,baseRefName,headRefName,headRefOid,isCrossRepository`.
2. Look for the head branch in `git worktree list --porcelain`. If any worktree (including the main checkout) has it checked out, use that path.
3. Otherwise create `<parent of main worktree>/<repo name>-pr-<n>` with `git fetch origin pull/<n>/head:<headRef>` (or the plain branch fetch for same-repo PRs) and `git worktree add <path> <headRef>`. Set upstream to `origin/<headRef>` for same-repo PRs.
4. Fetch the PR head and base. Compute sync state against `headRefOid`:
   - `in-sync`: local HEAD == PR head.
   - `updated`: PR head is ahead, tree clean → `git merge --ff-only` done.
   - `ahead`: local has commits not on the PR head (unpushed fixes).
   - `dirty`: uncommitted changes (reported alongside ahead/in-sync; dirty wins in `sync`, detail says both).
   - `diverged`: both moved. Nothing is changed. `canMakeChanges: false`.
5. `baseOid` = `git merge-base origin/<baseRef> HEAD`.
6. Write/refresh the store (`pr`, `mode`, `worktree`, `baseOid`), run reanchor, print `PreparedReview`.

`desk prepare .` prepares a `local-<branch>` review of the current worktree against `origin/<default branch>` merge-base.

## CLI

All commands accept `--json` (machine output on stdout, errors as `{"error": "..."}` with exit 1) and `--repo <path>` (default cwd). Commands that act on a review take `--pr <n>` or infer the review from the current worktree: the store whose `worktree` equals the current worktree root, else `local-<branch>`.

| Command | Output (`--json`) |
| --- | --- |
| `desk` | Opens Hunk with the extension on the current repo (PR pane visible). |
| `desk open <pr\|.>` | prepare, then exec `hunk diff <baseOid> --watch --extension <desk>/hunk-extension` in the worktree with `DESK_KEY`, `DESK_STORE`, `DESK_BIN` set. |
| `desk launch <pr\|.>` | prepare, then open a full tab running `desk open <pr>` via the launcher. `{tab: {...}, review: PreparedReview}` |
| `desk prepare <pr\|.>` | `PreparedReview` |
| `desk prs` | `PrListItem[]` (review requested, mine, recent others; up to 50) |
| `desk threads` | `{ review: PreparedReview-like summary, threads: Thread[] }` |
| `desk store-path` | `{ key, storePath }` |
| `desk comment add --file F --line L [--end-line E] [--side new\|old] --body B [--author you\|agent]` | `Thread` |
| `desk reply <id> --body B [--author you\|agent]` | `Thread`. A human reply on a `sent`/`addressed` thread also emits a `reply` event. An agent reply moves `draft` → `sent`. |
| `desk action <id> send\|make-changes\|queue\|unqueue\|dismiss\|reopen [--body B]` | `Thread`. `make-changes` refused unless `canMakeChanges`. |
| `desk wait [--timeout <seconds>]` | `{ events: DeskEvent[], threads: Thread[] }` for the threads those events reference. Default timeout 0 = wait forever. Polls the store every 500 ms. Exit 0 with empty events on timeout. |
| `desk done <id> [--message M] [--path P ...]` | Commits the working-tree changes (all, or only `--path`s) as one commit whose message is the thread's first message summary (first line, ≤ 72 chars) or `--message`, plus trailer `Desk-Thread: <key>/<id>`. Appends sha to `thread.commits`, state → `addressed`, runs reanchor, then best-effort `hunk session reload --repo <worktree> -- diff <baseOid>`. `{ thread, commit }` |
| `desk reanchor` | `{ changed: Thread[] }` |
| `desk sync` | Imports unresolved GitHub review threads on the PR as threads with `publish: published`, `state: sent`, author `you`, and each GitHub comment as a message whose body starts with `@<login>: `. Skips ones already linked by `github.commentId`. `{ imported: number }` |
| `desk publish [--event COMMENT\|APPROVE\|REQUEST_CHANGES] [--body B] [--yes]` | Posts one review via `gh api repos/{owner}/{repo}/pulls/<n>/reviews` with `commit_id` = PR head, `event`, `body`, and `comments[]` (`path`, `line` = endLine, `start_line` when range, `side` = `RIGHT` for new / `LEFT` for old, `body` = all thread messages by `you`, joined; agent messages are included only if the thread author is agent and you queued it — then its first message is the body). Refuses if local HEAD ≠ PR head and any queued thread is on `side: new` (positions would not match) unless `--force`. On success marks threads `published`, stores comment ids/urls. Without `--yes` asks for confirmation on the TTY. `{ reviewUrl, published: string[] }` |
| `desk push [--squash\|--keep] [--yes]` | Own/local only. Finds unpushed commits (`@{upstream}..HEAD`) with a `Desk-Thread` trailer. If ≥ 2 and `--squash` (or the user picks squash at the TTY prompt), squashes only those trailing review commits into one `Address review feedback` commit that keeps every trailer (refuses to squash if non-desk commits are interleaved after the first desk commit; offers keep). Re-links `thread.commits` to the new sha. Then `git push`. Never force-pushes. `{ squashed: boolean, pushed: string }` |

## Hunk extension responsibilities

- Reads `DESK_STORE`, `DESK_KEY`, `DESK_BIN` from env (set by `desk open`); if missing, runs `desk store-path --json` in the cwd.
- Watches the store file and re-renders on change.
- Mirrors every non-dismissed thread into the live Hunk session as notes (via its API or `hunk session comment add --repo <worktree>`), with a summary prefix like `[agent · draft]`, `[you · stale]`, `[addressed 3f2a1c]`, `[queued ↑]`, and a footer line listing the available keys. Re-syncs when the store changes.
- PR pane (left): `desk prs --json`. Enter → `desk prepare <n> --json`, then repoint the window with `hunk session reload --session-path <cwd> --source <worktree> -- diff <baseOid>`, and switch `DESK_STORE`/`DESK_KEY` in-process.
- Threads pane (right): threads with state and publish badges, messages, and the actions.
- Keys (remappable): `c` new comment on current line (yours, draft), `s` send, `m` make changes (hidden in teammate mode), `p` add PR comment / unqueue toggle, `r` reply, `x` dismiss, `P` publish (asks Comment / Approve / Request changes and an optional body, then `desk publish --yes --event …`), `o` open current file:line in Cursor (`cursor -g <worktree>/<path>:<line>`), `O` open the worktree in Cursor (`cursor <worktree>`), `t` focus threads pane, `g` focus PR pane.
- After a reload (`changeset_loaded` / `session_reload`), runs `desk reanchor --json`.

## Launcher (`src/launch/index.ts`)

```ts
export interface TabRequest { cwd: string; label: string; argv: string[]; }
export interface TabResult { via: "herdr" | "tuios" | "wezterm" | "print"; detail: string; }
export function launchTab(req: TabRequest): Promise<TabResult>;
```

Picks the innermost multiplexer: herdr (`HERDR_ENV=1`), then tuios (its session env var), then WezTerm (`WEZTERM_PANE`), else returns `print` with the command for the user to run. If a tab with the same label already exists (herdr, tuios), focus it instead of creating another.
