import { spawn } from "node:child_process";
import type { NoteSpec } from "./format.ts";

export interface LiveNote {
  noteId: string;
  parentId?: string;
  source: "ai" | "agent" | "user";
  filePath: string;
  body: string;
}

interface ListedSession {
  sessionId: string;
  pid: number;
  cwd: string;
  repoRoot?: string;
}

export function runProcess(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

async function hunkJson(args: readonly string[], input?: string): Promise<unknown> {
  const sep = args.indexOf("--");
  const full = sep < 0 ? [...args, "--json"] : [...args.slice(0, sep), "--json", ...args.slice(sep)];
  const r = await runProcess("hunk", full, { input });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || `hunk exited ${r.code}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

export class HunkSession {
  private sessionId: string | null = null;
  worktree: string;

  constructor(worktree: string) {
    this.worktree = worktree;
  }

  async id(): Promise<string | null> {
    if (this.sessionId) return this.sessionId;
    try {
      const out = (await hunkJson(["session", "list"])) as { sessions?: ListedSession[] };
      this.sessionId = out.sessions?.find((s) => s.pid === process.pid)?.sessionId ?? null;
    } catch {
      this.sessionId = null;
    }
    return this.sessionId;
  }

  private async selector(): Promise<string[]> {
    const id = await this.id();
    return id ? [id] : ["--repo", this.worktree];
  }

  async apply(specs: readonly NoteSpec[]): Promise<string[]> {
    if (specs.length === 0) return [];
    const comments = specs.map((s) => ({
      filePath: s.filePath,
      ...(s.side === "old" ? { oldLine: s.line } : { newLine: s.line }),
      summary: s.summary,
      ...(s.rationale ? { rationale: s.rationale } : {}),
      author: s.author,
    }));
    const out = (await hunkJson(
      ["session", "comment", "apply", ...(await this.selector()), "--stdin"],
      JSON.stringify({ comments }),
    )) as { result?: { applied?: { commentId: string }[] } };
    return (out.result?.applied ?? []).map((a) => a.commentId);
  }

  async add(spec: NoteSpec): Promise<string> {
    const out = (await hunkJson([
      "session",
      "comment",
      "add",
      ...(await this.selector()),
      "--file",
      spec.filePath,
      spec.side === "old" ? "--old-line" : "--new-line",
      String(spec.line),
      "--summary",
      spec.summary,
      ...(spec.rationale ? ["--rationale", spec.rationale] : []),
      "--author",
      spec.author,
    ])) as { result?: { commentId?: string } };
    const id = out.result?.commentId;
    if (!id) throw new Error("hunk did not return a comment id");
    return id;
  }

  async remove(noteId: string): Promise<void> {
    await hunkJson(["session", "comment", "rm", ...(await this.selector()), noteId]);
  }

  async list(): Promise<LiveNote[]> {
    const out = (await hunkJson(["session", "comment", "list", ...(await this.selector()), "--type", "all"])) as {
      comments?: LiveNote[];
    };
    return out.comments ?? [];
  }

  async reload(source: string, baseOid: string): Promise<void> {
    const id = await this.id();
    const target = id ? [id] : ["--session-path", process.cwd()];
    await hunkJson(["session", "reload", ...target, "--source", source, "--", "diff", baseOid]);
    this.worktree = source;
  }
}
