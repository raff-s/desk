import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStore } from "../../src/core/store.ts";
import type { Store } from "../../src/core/types.ts";

const configHome = mkdtempSync(join(tmpdir(), "desk-gitconfig-"));
writeFileSync(join(configHome, "gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
process.env.GIT_CONFIG_GLOBAL = join(configHome, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.DESK_HUNK = join(configHome, "no-such-hunk");

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
}

export function write(root: string, path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

export function commitFile(root: string, path: string, content: string, message = `edit ${path}`): string {
  write(root, path, content);
  git(root, "add", "--", path);
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

export const APP_LINES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
export const lines = (...l: string[]) => `${l.join("\n")}\n`;

export interface Fixture {
  base: string;
  origin: string;
  main: string;
  clone(name: string): string;
}

export function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "desk-test-")));
  const origin = join(base, "origin.git");
  const main = join(base, "repo");
  git(base, "init", "-q", "--bare", origin);
  git(base, "init", "-q", main);
  git(main, "remote", "add", "origin", origin);
  commitFile(main, "src/app.ts", lines(...APP_LINES), "initial");
  commitFile(main, "README.md", "# repo\n", "readme");
  git(main, "push", "-q", "-u", "origin", "main");
  git(main, "remote", "set-head", "origin", "main");
  return {
    base,
    origin,
    main,
    clone(name: string) {
      const dir = join(base, name);
      git(base, "clone", "-q", origin, dir);
      return dir;
    },
  };
}

export function pushBranchFrom(fix: Fixture, branch: string, file: string, content: string): string {
  const dev = fix.clone(`dev-${branch.replace(/\W/g, "_")}-${Math.random().toString(36).slice(2, 6)}`);
  git(dev, "checkout", "-q", "-b", branch, "origin/main");
  const sha = commitFile(dev, file, content, `work on ${branch}`);
  git(dev, "push", "-q", "origin", branch);
  return sha;
}

export function pushMoreTo(fix: Fixture, branch: string, file: string, content: string): string {
  const dev = fix.clone(`dev-more-${Math.random().toString(36).slice(2, 6)}`);
  git(dev, "checkout", "-q", "-b", branch, `origin/${branch}`);
  const sha = commitFile(dev, file, content, `more ${branch}`);
  git(dev, "push", "-q", "origin", branch);
  return sha;
}

export function storeFor(root: string, over: Partial<Store> = {}): Store {
  return { ...emptyStore("local-main"), worktree: root, baseOid: git(root, "rev-parse", "HEAD"), ...over };
}

// --- fake gh ---------------------------------------------------------------

const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const args = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + "\\n");
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
const [a, b] = args;
if (a === "api" && b === "user") out(state.user + "\\n");
else if (a === "pr" && b === "view") out(state.prs[args[2]]);
else if (a === "pr" && b === "list") {
  const flag = (n) => args[args.indexOf(n) + 1];
  if (args.includes("--head")) out(state.byHead[flag("--head")] || []);
  else if (args.includes("--search")) out(state.lists["review-requested"] || []);
  else if (args.includes("--author")) out(state.lists.mine || []);
  else out(state.lists.other || []);
} else if (a === "repo") out({ nameWithOwner: state.repo });
else if (a === "api" && b === "graphql") out(state.graphql);
else if (a === "api" && args.includes("POST")) out(state.reviewResponse);
else if (a === "api" && /reviews\\/\\d+\\/comments$/.test(b)) out(state.reviewComments || []);
else { console.error("fake gh: unexpected call: " + args.join(" ")); process.exit(1); }
`;

export interface GhCall {
  args: string[];
  stdin: string;
}

export interface FakeGh {
  state: Record<string, unknown>;
  save(): void;
  calls(): GhCall[];
}

export function rawPr(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "Add feature",
    url: "https://github.com/acme/repo/pull/7",
    author: { login: "alice" },
    baseRefName: "main",
    headRefName: "feature",
    headRefOid: "",
    isCrossRepository: false,
    ...over,
  };
}

export function installFakeGh(initial: Record<string, unknown> = {}): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), "desk-fakegh-"));
  const bin = join(dir, "gh");
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "calls.log");
  writeFileSync(bin, FAKE_GH);
  chmodSync(bin, 0o755);
  writeFileSync(logPath, "");
  process.env.DESK_GH = bin;
  process.env.FAKE_GH_STATE = statePath;
  process.env.FAKE_GH_LOG = logPath;
  const state: Record<string, unknown> = {
    user: "me",
    repo: "acme/repo",
    prs: {},
    byHead: {},
    lists: {},
    graphql: {},
    reviewResponse: { id: 99, html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-99" },
    reviewComments: [],
    ...initial,
  };
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  save();
  return {
    state,
    save,
    calls: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as GhCall),
  };
}

export function setPr(gh: FakeGh, number: number, pr: Record<string, unknown>): void {
  (gh.state.prs as Record<string, string>)[String(number)] = JSON.stringify(pr);
  gh.save();
}

export function prFixture(author = "me") {
  const fix = makeFixture();
  const gh = installFakeGh();
  const head = pushBranchFrom(fix, "feature", "src/feature.ts", "export const f = 1;\n");
  setPr(gh, 7, rawPr({ headRefOid: head, author: { login: author } }));
  const advance = (file = "src/more.ts") => {
    const next = pushMoreTo(fix, "feature", file, "more\n");
    setPr(gh, 7, rawPr({ headRefOid: next, author: { login: author } }));
    return next;
  };
  return { fix, gh, head, advance };
}

