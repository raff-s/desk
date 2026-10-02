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

Each successful wait returns `{ events, threads }`. Handle every event, including ones already queued before this session started.
When it returns several `make-changes` events, treat them as one batch: inspect all requests first, apply all compatible edits, run the relevant test suite once, then finish them together.

## Continue a review

If a previous agent session died, the human can say "continue the desk review" or "run desk wait". Do that. Do not start a new review and do not add the same findings again.

1. `desk threads --json` (add `--pr <n>` when they named one) to see what is already there.
2. `desk wait --json`. Events with `consumed: false` are still yours, including `make-changes` requests the last session never took.
3. Handle each one, then wait again.

Quitting Hunk does not drop the store or the wait. Comments live in `.git/desk/` inside the repo under review.

## Event: `send`

The human sent a thread for you to read. Inspect the thread in `threads`. Reply locally:

`desk reply <id> --author agent --body "<answer>"`

Do not edit code unless they also chose Make changes (separate event).

## Event: `reply`

The human replied on an already-sent thread. Answer with `desk reply <id> --author agent --body "..."`.

## Event: `make-changes`

The human queued one or more changes and pressed `M`. Implement only what those threads and optional event bodies ask for, in the **review worktree** (`PreparedReview.worktree`).

1. Read every `make-changes` event returned by this wait before editing.
2. Apply all compatible edits. If two requests conflict, reply on both and stop before guessing.
3. Run relevant tests once after the batch is complete.
4. `desk done <id1> <id2> ... --json` (optionally `--path` for a partial commit). This creates one review-feedback commit and links it to every included thread.
5. Reply briefly on each thread with what changed.

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

## Keys the human actually presses

From the diff: `T` threads (`j`/`k` move, Enter back), `L` PR list (`Esc` closes it), `c` comment, `S` send, `i` queue/unqueue this change, `M` send all queued changes to you, `p` queue a PR comment, `R` reply, `x` dismiss, `P` publish, `o`/`O` open in Cursor, `q` quit Hunk.

Inside the threads pane: `m` queue/unqueue this change, `M` send all queued changes, `s` send a question, `r` reply, `g` PR list.

When you tell the human how to do something, use these keys, not `s`/`m`/`t`/`g` from the diff. Publishing and pushing stay human actions unless they ask in chat.
