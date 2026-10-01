import { spawnSync } from "node:child_process";
import { fail } from "./errors.ts";
import { deskBin, extensionDir } from "./paths.ts";
import { prepare, parseTarget } from "./prepare.ts";
import type { PreparedReview } from "./types.ts";

export interface OpenSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function openSpec(review: PreparedReview): OpenSpec {
  return {
    command: process.env.DESK_HUNK || "hunk",
    args: ["diff", review.baseOid, "--watch", "--extension", extensionDir],
    cwd: review.worktree,
    env: { DESK_KEY: review.key, DESK_STORE: review.storePath, DESK_BIN: deskBin },
  };
}

export function execHunk(spec: OpenSpec): number {
  const res = spawnSync(spec.command, spec.args, {
    cwd: spec.cwd,
    stdio: "inherit",
    env: { ...process.env, ...spec.env },
  });
  if (res.error) fail(`Could not run ${spec.command}: ${res.error.message}`);
  return res.status ?? 1;
}

export interface TabRequest {
  cwd: string;
  label: string;
  argv: string[];
}

export interface TabResult {
  via: string;
  detail: string;
}

export async function launchReview(repo: string, rawTarget: string): Promise<{ tab: TabResult; review: PreparedReview }> {
  const review = await prepare(repo, parseTarget(rawTarget));
  const launcher = (await import(new URL("../launch/index.ts", import.meta.url).href)) as {
    launchTab(req: TabRequest): Promise<TabResult>;
  };
  const target = review.pr ? String(review.pr.number) : ".";
  const tab = await launcher.launchTab({
    cwd: review.worktree,
    label: `desk ${review.key}`,
    argv: [deskBin, "open", target],
  });
  return { tab, review };
}
