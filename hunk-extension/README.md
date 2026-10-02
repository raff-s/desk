# desk Hunk extension

The review screen for desk. Loaded by `desk open` via `hunk diff <base> --watch --extension <desk>/hunk-extension`
(Hunk ≥ 0.23, extension API 28). It never writes the store; it reads `DESK_STORE` and runs
`node $DESK_BIN <command> --json`.

- `index.ts`: registration (panes, commands, keyboard modes, events, note mirroring, PR switching)
- `format.ts`: pure formatting/selection helpers (unit-tested: `npm test`)
- `panes.ts`, `state.ts`: the two panes and their shared state
- `desk.ts`, `session.ts`: the `desk` and `hunk session` CLIs

The extension id is the folder name, so commands are `hunk-extension.<id>`.

## Keys

Hunk's built-ins win key conflicts, and `c s m r t g` are built-ins. So the global defaults avoid them,
and the contract letters work inside the threads pane (`T`).

| Contract | Global default | In threads pane | Notes |
| --- | --- | --- | --- |
| `c` comment | `c` (Hunk note editor), `C` (dialog) | — | A saved Hunk note becomes a desk draft thread |
| `s` send | `S` | `s` | |
| queue change | `i` | `m` | Queue/unqueue this thread without waking the agent; hidden in teammate mode |
| send queued changes | `M` | `M` | Deliver every queued change to the agent as one batch |
| `p` PR comment toggle | `p` | `p` | Hidden in local mode |
| `r` reply | `R` (Hunk reply on the note), `A` (dialog) | `r` | Asks: reply / reply + send / reply + make changes |
| `x` dismiss | `x` | `x` | |
| `P` publish | `P` | `P` | Comment / Approve / Request changes, then optional body |
| `o` / `O` | `o` / `O` | `o` / `O` | `cursor -g <worktree>/<path>:<line>` / `cursor <worktree>` |
| `t` threads | `T` | `j`/`k` move, Enter/`t`/Esc back, `g` PRs | |
| `g` PRs | `L` | type to filter, ↑↓ move, Enter open, Tab threads, Esc closes the PR pane | |

To walk agent comments, press `T` to focus the threads pane and use `j` / `k`.
Each move selects the thread and reveals its exact file and line in the diff.
Press Enter, `t`, or Esc to return focus to the diff; the selected code stays visible.

To get the contract letters globally (taking them from Hunk's files-pane, hunk-headers, refresh, theme,
and jump-to-top defaults), add this to `~/.config/hunk/config.toml`:

```toml
[keybindings]
"hunk-extension.send" = "s"
"hunk-extension.queue-changes" = "m"
"hunk-extension.reply" = "r"
"hunk-extension.threads" = "t"
"hunk-extension.prs" = "g"
```

Note footers read the live bindings, so they follow any remap.

## Text input

New comments and replies use Hunk's own multi-line note editor (`c`, `R`, Ctrl-S to save). The
extension turns the saved note into `desk comment add` / `desk reply` and replaces it with the
mirrored note. `C`, `A`, `r`, and the publish body use the one-line `ctx.dialogs.input` dialog.

## Limits (Hunk 0.23)

- `hunk session reload --source` refuses paths outside the repo root the window was launched in.
  desk's PR worktrees are sibling directories, so Enter on such a PR runs `desk launch <n>` (new tab)
  instead. If `DESK_HANDOFF` is set, it writes the `PreparedReview` there and quits Hunk, so a
  relaunching `desk open` can take over. PRs whose branch is checked out in this window's worktree
  repoint in place.
- Notes are one per thread, re-created on change (no in-place edit API). Threads on files outside
  the diff appear only in the threads pane.
- Keyboard modes start only from a key; there is no always-on desk mode.
