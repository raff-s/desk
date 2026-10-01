import { spawn } from "node:child_process";
import { fail } from "./errors.ts";
import type { PullRequestInfo } from "./types.ts";

export const ghBinary = () => process.env.DESK_GH || "gh";

export function gh(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ghBinary(), args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => reject(new Error(`gh failed to start: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export async function ghJson<T>(cwd: string, args: string[], input?: string): Promise<T> {
  const out = await gh(cwd, args, input);
  try {
    return JSON.parse(out) as T;
  } catch {
    return fail(`gh ${args.slice(0, 2).join(" ")} returned invalid JSON`);
  }
}

export async function currentUser(cwd: string): Promise<string> {
  return (await gh(cwd, ["api", "user", "--jq", ".login"])).trim();
}

export async function repoSlug(cwd: string): Promise<string> {
  const res = await ghJson<{ nameWithOwner: string }>(cwd, ["repo", "view", "--json", "nameWithOwner"]);
  return res.nameWithOwner;
}

interface RawPr {
  number: number;
  title: string;
  url: string;
  author: { login: string };
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
}

export async function viewPr(cwd: string, number: number): Promise<PullRequestInfo> {
  const fields = "number,title,url,author,baseRefName,headRefName,headRefOid,isCrossRepository";
  const raw = await ghJson<RawPr>(cwd, ["pr", "view", String(number), "--json", fields]);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author.login,
    baseRef: raw.baseRefName,
    headRef: raw.headRefName,
    headOid: raw.headRefOid,
    isCrossRepository: raw.isCrossRepository,
  };
}

export async function openPrForBranch(cwd: string, branch: string): Promise<number | null> {
  try {
    const list = await ghJson<{ number: number }[]>(cwd, [
      "pr", "list", "--head", branch, "--state", "open", "--json", "number", "--limit", "1",
    ]);
    return list[0]?.number ?? null;
  } catch {
    return null;
  }
}
