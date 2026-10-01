import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/core/args.ts";
import { listPrs } from "../src/core/prs.ts";
import { git, prFixture, write } from "./helpers/fixture.ts";

const bin = fileURLToPath(new URL("../bin/desk.ts", import.meta.url));

function desk(cwd: string, ...args: string[]) {
  return deskEnv(cwd, {}, ...args);
}

function deskEnv(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  const res = spawnSync(process.execPath, [bin, ...args, "--json"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const stdout = res.stdout.trim();
  return { status: res.status, data: stdout ? JSON.parse(stdout) : null, stderr: res.stderr };
}

test("bin/desk.ts is executable with a node shebang", () => {
  assert.ok(statSync(bin).mode & 0o100);
  assert.equal(spawnSync("head", ["-1", bin], { encoding: "utf8" }).stdout.trim(), "#!/usr/bin/env node");
});

test("argument parsing accepts dash-leading values, = form, repeats and rejects unknowns", () => {
  const a = parseArgs(["comment", "add", "--body", "- bullet", "--line=4", "--path", "a", "--path", "b", "--yes", "--", "--odd"]);
  assert.deepEqual(a.positionals, ["comment", "add", "--odd"]);
  assert.equal(a.str("body"), "- bullet");
  assert.equal(a.num("line"), 4);
  assert.deepEqual(a.all("path"), ["a", "b"]);
  assert.equal(a.has("yes"), true);
  assert.equal(a.has("json"), false);
  assert.throws(() => parseArgs(["--nope"]), /Unknown option --nope/);
  assert.throws(() => parseArgs(["--body"]), /needs a value/);
  assert.throws(() => parseArgs(["--line", "x"]).num("line"), /expects a number/);
  assert.throws(() => parseArgs(["--yes=1"]), /does not take a value/);
});

test("end to end: prepare, comment, send, wait, and refusals as JSON errors", async () => {
  const { fix } = prFixture("alice");
  const prepared = desk(fix.main, "prepare", "7");
  assert.equal(prepared.status, 0);
  assert.equal(prepared.data.mode, "teammate");
  const worktree = prepared.data.worktree;

  const added = desk(worktree, "comment", "add", "--file", "src/feature.ts", "--line", "1", "--body", "- why a constant?");
  assert.equal(added.status, 0);
  assert.equal(added.data.id, "t1");
  assert.equal(added.data.anchor.snippet[0], "export const f = 1;");

  const sent = desk(worktree, "action", "t1", "send");
  assert.equal(sent.data.state, "sent");

  const refused = desk(worktree, "action", "t1", "make-changes");
  assert.equal(refused.status, 1);
  assert.match(refused.data.error, /comments-only/);

  const waited = desk(worktree, "wait", "--timeout", "1");
  assert.deepEqual(waited.data.events.map((e: { kind: string }) => e.kind), ["send"]);
  assert.equal(waited.data.threads[0].id, "t1");
  assert.deepEqual(desk(worktree, "wait", "--timeout", "1").data.events, []);

  write(worktree, "src/feature.ts", "// header\nexport const f = 1;\n");
  const threads = desk(worktree, "threads", "--pr", "7");
  assert.equal(threads.data.review.key, "pr-7");
  assert.equal(threads.data.threads[0].startLine, 2);

  const done = desk(worktree, "done", "t1");
  assert.equal(done.status, 1);
  assert.match(done.data.error, /comments-only/);

  const storePath = desk(worktree, "store-path");
  assert.equal(storePath.data.storePath, prepared.data.storePath);
  assert.equal(desk(worktree, "bogus").status, 1);

  const local = desk(worktree, "prepare", ".");
  assert.equal(local.data.key.startsWith("local-"), true);
  const keyed = deskEnv(worktree, { DESK_KEY: local.data.key }, "store-path");
  assert.equal(keyed.data.key, local.data.key);
  assert.notEqual(keyed.data.key, "pr-7");

  const before = statSync(prepared.data.storePath).mtimeMs;
  const again = desk(worktree, "reanchor", "--pr", "7");
  assert.deepEqual(again.data.changed, []);
  assert.equal(statSync(prepared.data.storePath).mtimeMs, before);
});

test("open prints the Hunk invocation with the desk environment", () => {
  const { fix } = prFixture();
  const opened = desk(fix.main, "open", "7");
  assert.equal(opened.status, 0);
  const { command, review } = opened.data;
  assert.deepEqual(command.args.slice(0, 4), ["diff", review.baseOid, "--watch", "--extension"]);
  assert.ok(command.args[4].endsWith("/hunk-extension"));
  assert.equal(command.cwd, review.worktree);
  assert.equal(command.env.DESK_KEY, "pr-7");
  assert.equal(command.env.DESK_STORE, review.storePath);
  assert.equal(command.env.DESK_BIN, bin);
});

test("bare desk opens the PR of the current branch, else a local review", () => {
  const { fix, gh } = prFixture();
  gh.state.byHead = { feature: [{ number: 7 }] };
  gh.save();
  const first = desk(fix.main, "prepare", "7");
  const viaPr = desk(first.data.worktree);
  assert.equal(viaPr.data.review.key, "pr-7");

  const viaLocal = desk(fix.main);
  assert.equal(viaLocal.data.review.key, "local-main");
  assert.equal(viaLocal.data.review.mode, "local");
});

test("desk . after local edits supports comment and done on a local review", () => {
  const { fix } = prFixture();
  git(fix.main, "checkout", "-q", "-b", "scratch");
  const opened = desk(fix.main, ".");
  assert.equal(opened.data.review.key, "local-scratch");
  desk(fix.main, "comment", "add", "--file", "src/app.ts", "--line", "2", "--body", "tighten this", "--author", "agent");
  desk(fix.main, "action", "t1", "make-changes");
  write(fix.main, "src/app.ts", "alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n");
  const done = desk(fix.main, "done", "t1");
  assert.equal(done.status, 0);
  assert.equal(done.data.thread.state, "addressed");
  assert.equal(git(fix.main, "log", "-1", "--format=%B").split("\n").at(-1), "Desk-Thread: local-scratch/t1");
});

test("prs groups, dedupes, and reports worktrees and open threads", async () => {
  const { fix, gh } = prFixture();
  const pr = (number: number, headRefName: string, updatedAt: string, login = "alice") => ({
    number, title: `PR ${number}`, author: { login }, headRefName, updatedAt,
  });
  gh.state.lists = {
    "review-requested": [pr(7, "feature", "2026-01-02T00:00:00Z")],
    mine: [pr(8, "mine-branch", "2026-01-03T00:00:00Z", "me"), pr(7, "feature", "2026-01-02T00:00:00Z")],
    other: [pr(9, "other", "2026-01-04T00:00:00Z"), pr(8, "mine-branch", "2026-01-03T00:00:00Z", "me"), pr(10, "main", "2026-01-01T00:00:00Z")],
  };
  gh.save();
  const first = desk(fix.main, "prepare", "7");
  desk(first.data.worktree, "comment", "add", "--file", "src/feature.ts", "--line", "1", "--body", "hm");

  const items = await listPrs(fix.main);
  assert.deepEqual(items.map((i) => [i.number, i.group]), [
    [7, "review-requested"], [8, "mine"], [9, "other"], [10, "other"],
  ]);
  assert.equal(items[0]?.worktree, join(fix.base, "repo-pr-7"));
  assert.equal(items[0]?.openThreads, 1);
  assert.equal(items[1]?.worktree, null);
  assert.equal(items[3]?.worktree, fix.main);
});

test("launch prepares the review and hands `desk open` to the launcher", () => {
  const { fix } = prFixture();
  const env = { ...process.env, HERDR_ENV: "", TUIOS_ENV: "", WEZTERM_PANE: "" };
  const res = spawnSync(process.execPath, [bin, "launch", "7", "--json"], { cwd: fix.main, encoding: "utf8", env });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.review.key, "pr-7");
  assert.equal(out.tab.via, "print");
  assert.ok(out.tab.detail.includes(`${bin} open 7`), out.tab.detail);
});
