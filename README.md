# desk

A terminal review for pull requests. You and your coding agent share comments on the diff. Nothing is posted to GitHub until you publish it yourself.

The diff opens in [Hunk](https://hunk.dev). Comments live in `.git/desk/` inside the repo you are reviewing, so quitting Hunk does not lose them.

## Install

You need Node 24 or newer, the [GitHub CLI](https://cli.github.com/) (`gh auth login`), and Hunk 0.23 or newer (`brew install hunk`).

```bash
git clone git@github.com:raff-s/desk.git ~/desk
cd ~/desk
npm install
npm link
```

`npm link` puts the `desk` command on your PATH. On a second machine, clone and run the same three commands.

Optional, for opening the review in a new tab: [herdr](https://herdr.dev), [tuios](https://tuios.dev), or WezTerm. The `o` and `O` keys open the file or the worktree in Cursor when the `cursor` command is on your PATH.

### Teach your agent

```bash
ln -sfn ~/desk/skills/desk ~/.cursor/skills/desk
ln -sfn ~/desk/skills/desk ~/.claude/skills/desk
```

The skill is `skills/desk/SKILL.md`. Start a new agent chat after linking it.

## Review a pull request

From the repo that contains the PR:

```bash
desk              # open the current branch, or its open PR
desk open 874     # open pull request 874
```

Or ask the agent: **Review PR 874 with desk.**

It reads the whole diff, writes each finding as a local draft, and opens Hunk. It does not post anything to GitHub.

If the agent session dies after you press Make changes, start a new one in the same repo and say: **Continue the desk review. Run desk wait.** The requests are still in the store. The agent picks them up, edits the code, and marks each thread addressed.

## Keys

Hunk already uses several of the letters desk would like, so these are the keys that work from the diff. Press `T` first if you want the shorter letters in the last column.

| From the diff | In the threads pane | What it does |
| --- | --- | --- |
| `T`, then `j` / `k` | `j` / `k` | Next or previous comment. The diff jumps to that line. |
| `Enter`, `t`, or `Esc` | same | Leave the threads pane. The code you jumped to stays on screen. |
| `L` | `g` | Pull request list. `Esc` closes it. `Enter` opens the selected PR. |
| `c` or `C` | | Comment on the current line. Save with `Ctrl-S`. |
| `S` | `s` | Send the comment to the agent. |
| `i` | `m` | Make changes. The agent edits this thread. Hidden on someone else's PR. |
| `p` | `p` | Queue this comment for GitHub, or take it back out of the queue. |
| `R` or `A` | `r` | Reply. You can reply, send, or make changes from the same reply. |
| `x` | `x` | Dismiss. |
| `P` | `P` | Publish the queued comments as one GitHub review. |
| `o` / `O` | `o` / `O` | Open this line, or the whole worktree, in Cursor. |

Quit Hunk with `q`. Open it again with `desk open <number>`. Comments, queued publish state, and unanswered Make changes requests all come back.

## What a comment can do

A comment stays on your machine until you publish it.

- **Send** (`S`) asks the agent to read it and reply. The reply stays local.
- **Make changes** (`i`) asks the agent to edit the code for that comment. On your own PR it commits in your worktree and the note becomes **addressed**. On someone else's PR this action is not offered. You leave a comment, and they decide whether to try the idea.
- **Add PR comment** (`p`) only marks it. **Publish** (`P`) is what sends the marked comments, as one review: Comment, Approve, or Request changes.

`desk push` offers to squash the small per-thread commits that have not been pushed yet. It never force-pushes, and it refuses to push a review of someone else's PR.

## Where things live

| Path | What |
| --- | --- |
| `.git/desk/pr-<number>.json` | Threads for that pull request, shared by every worktree of the repo |
| `skills/desk/SKILL.md` | Instructions the agent follows |
| `docs/CONTRACT.md` | CLI and store contract |
| `hunk-extension/` | The Hunk screen |
