---
name: desk
description: >-
  Review a PR with desk, open a review in desk, use desk for code review,
  addressing desk comments, waiting for desk review comments, or when the user
  says "desk".
---

# desk agent workflow

desk is a terminal review tool: you draft threads via the CLI, the human reviews in Hunk, and nothing hits GitHub until they run `desk publish`. Read `docs/CONTRACT.md` in the desk repo for full CLI semantics.

## Hard rules

- Never run `desk publish` or `desk push` unless the user explicitly asks in chat.
- Never post review feedback to GitHub any other way (`gh pr comment`, inline reviews, etc.).
- Never put secrets, tokens, or credentials in comment bodies.
- Keep comment bodies short and in the user's language.

## Review a pull request

1. `desk prepare <n> --json` — note `worktree`, `baseOid`, `mode`, `canMakeChanges`, `sync`.
2. In that worktree, read the diff: `git diff <baseOid>`. Read surrounding code, not only the diff hunks.
3. For each finding, add a draft thread:
   `desk comment add --file <path> --line <L> [--end-line <E>] [--side new|old] --body "<text>" --author agent --json`
   - `side: new` for added or context lines; `side: old` for deleted lines.
   - Anchor precisely (single line or range).
4. `desk launch <n> --json` — opens a full terminal tab with Hunk for the user (do not skip unless they asked to stay in-editor only).
5. Loop on events (see below) until the user says they are done.

## Self-review (your own edits)

After you change code locally: `desk prepare . --json`, then the same comment → launch → wait loop against the current branch worktree.

## Waiting for the human

Run `desk wait --json` in the **foreground** with a long timeout (for example `--timeout 3600`). When it returns empty events, run it again. Keep looping until the user says the review is finished.

Each successful wait returns `{ events, threads }`. Handle every event.

## Event: `send`

The human sent a thread for you to read. Inspect the thread in `threads`. Reply locally:

`desk reply <id> --author agent --body "<answer>"`

Do not edit code unless they also chose Make changes (separate event).

## Event: `reply`

The human replied on an already-sent thread. Answer with `desk reply <id> --author agent --body "..."`.

## Event: `make-changes`

Implement only what the thread and optional event `body` ask for, in the **review worktree** (`PreparedReview.worktree`).

1. Edit files; run relevant tests from that worktree.
2. `desk done <id> --json` (optionally `--path` for partial commits).
3. `desk reply <id> --author agent --body "<brief summary of what changed>"`.

If `canMakeChanges` is false (teammate mode), do **not** edit code. Reply explaining teammate mode and include a suggested patch or snippet in the reply body.

## Teammate vs own PR

- **own** / **local**: `make-changes`, `done`, and `push` are allowed when sync allows it.
- **teammate**: comments and replies only; never modify the worktree for them.

## Useful commands

| Command | Purpose |
| --- | --- |
| `desk threads --json` | Current threads without waiting |
| `desk reanchor --json` | After manual edits, refresh line anchors |
| `desk store-path --json` | Locate the store file |

## Side pane keys (human)

The Hunk extension uses: `c` comment, `s` send, `m` make changes, `p` queue/unqueue PR comment, `r` reply, `x` dismiss, `P` publish, `o` open file in Cursor, `O` open worktree, `t` threads pane, `g` PR pane.

Publishing and pushing are human actions unless explicitly requested in chat.
