import { Args, parseArgs } from "./args.ts";
import { commands, defaultCommand } from "./commands.ts";
import type { Handler } from "./commands.ts";
import { DeskError, errorMessage } from "./errors.ts";

const USAGE = `desk - terminal review desk

  desk                           open the current worktree (its PR if it has one)
  desk open|launch|prepare <pr|.>
  desk prs | threads | store-path | reanchor | sync
  desk comment add --file F --line L [--end-line E] [--side new|old] --body B [--author you|agent]
  desk reply <id> --body B [--author you|agent]
  desk action <id> send|make-changes|queue|unqueue|dismiss|reopen [--body B]
  desk wait [--timeout seconds]
  desk done <id> [--message M] [--path P ...]
  desk publish [--event COMMENT|APPROVE|REQUEST_CHANGES] [--body B] [--yes] [--force]
  desk push [--squash|--keep] [--yes]

Every command takes --json and --repo <path>; review commands also take --pr <n>.`;

function resolveHandler(args: Args): Handler | null {
  const name = args.positionals[0];
  if (name === undefined) return defaultCommand;
  if (name === "." || /^#?\d+$/.test(name)) {
    args.positionals.unshift("open");
    return commands.open!;
  }
  return Object.hasOwn(commands, name) ? commands[name]! : null;
}

export async function main(argv: string[]): Promise<number> {
  let json = argv.includes("--json");
  try {
    const args = parseArgs(argv);
    json = args.has("json");
    if (args.has("help") || args.positionals[0] === "help") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const handler = resolveHandler(args);
    if (!handler) throw new DeskError(`Unknown command '${args.positionals[0]}'. Run desk --help`);
    const out = await handler(args);
    if (out.exitCode === undefined || json) {
      process.stdout.write(json ? `${JSON.stringify(out.data)}\n` : out.text ? `${out.text}\n` : "");
    }
    return out.exitCode ?? 0;
  } catch (err) {
    const message = errorMessage(err);
    if (json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    else process.stderr.write(`desk: ${message}\n`);
    return 1;
  }
}
