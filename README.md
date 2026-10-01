# desk

desk is a terminal code-review desk for pull requests and local changes. You and an agent draft review threads in a shared store, explore the diff in [Hunk](https://hunk.dev) with a desk extension, and only publish to GitHub when you choose. The agent never posts upstream unless you explicitly ask it to run `desk publish`.

## Install

Requires Node 24+, [`gh`](https://cli.github.com/) authenticated, and Hunk 0.23+.

```bash
cd ~/desk && npm install && npm link
```

Optional but recommended for `desk launch`: [herdr](https://herdr.dev), [tuios](https://tuios.dev), or WezTerm, plus the Cursor CLI for `o` / `O` keys in the review UI.

### Agent skill

Symlink the skill so Cursor and Claude Code pick up the workflow (run these yourself):

```bash
ln -sf ~/desk/skills/desk ~/.cursor/skills/desk
ln -sf ~/desk/skills/desk ~/.claude/skills/desk
```

## Quick start

```bash
desk              # open Hunk on the current repo
desk open 638     # prepare PR 638 and start the review session
```

In chat: *“Review PR 638 with desk”* — the agent runs `desk prepare`, adds draft comments, `desk launch`, then `desk wait` in a loop.

## Review modes

| Mode | Who | Code changes |
| --- | --- | --- |
| **own** | Your PR | Allowed (`make-changes`, `done`, `push`) |
| **teammate** | Someone else's PR | Comments only |
| **local** | No PR (`desk .`) | Allowed; publish refused |

## Thread lifecycle (local)

- **draft** → **sent** (Send, or agent reply) → **making-changes** (Make changes) → **addressed** (`desk done`).
- **stale** when re-anchoring cannot find the snippet; **dismissed** when closed.
- **publish** is separate: `none` → `queued` → **published** only via `desk publish`.

## Keys in the review UI

| Key | Action |
| --- | --- |
| `c` | New comment on current line (yours, draft) |
| `s` | Send thread to agent |
| `m` | Make changes (hidden in teammate mode) |
| `p` | Queue / unqueue GitHub PR comment |
| `r` | Reply |
| `x` | Dismiss |
| `P` | Publish review (Comment / Approve / Request changes) |
| `o` | Open file:line in Cursor |
| `O` | Open review worktree in Cursor |
| `t` | Focus threads pane |
| `g` | Focus PR list pane |

See `docs/CONTRACT.md` for the full CLI and store contract.
