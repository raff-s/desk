import { fail } from "./errors.ts";

const STRING_OPTIONS = [
  "repo", "pr", "file", "line", "end-line", "side", "body", "author", "timeout", "message", "event", "path",
];
const BOOLEAN_OPTIONS = ["json", "yes", "force", "squash", "keep", "help"];

export class Args {
  positionals: string[] = [];
  private values = new Map<string, string[]>();
  private flags = new Set<string>();

  has(name: string): boolean {
    return this.flags.has(name);
  }

  str(name: string): string | undefined {
    return this.values.get(name)?.at(-1);
  }

  all(name: string): string[] {
    return this.values.get(name) ?? [];
  }

  num(name: string): number | undefined {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fail(`--${name} expects a number, got '${raw}'`);
  }

  require(name: string): string {
    return this.str(name) ?? fail(`Missing --${name}`);
  }

  requireNum(name: string): number {
    return this.num(name) ?? fail(`Missing --${name}`);
  }

  pick<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const raw = this.str(name);
    if (raw === undefined) return fallback;
    return (allowed as readonly string[]).includes(raw) ? (raw as T) : fail(`--${name} must be one of: ${allowed.join(", ")}`);
  }

  add(name: string, value: string): void {
    this.values.set(name, [...(this.values.get(name) ?? []), value]);
  }

  flag(name: string): void {
    this.flags.add(name);
  }
}

// Not node:util parseArgs: it rejects option values that start with "-" (e.g. --body "- item").
export function parseArgs(argv: string[]): Args {
  const args = new Args();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      args.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      args.flag("help");
      continue;
    }
    if (!arg.startsWith("--")) {
      args.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (BOOLEAN_OPTIONS.includes(name)) {
      if (eq >= 0) fail(`--${name} does not take a value`);
      args.flag(name);
    } else if (STRING_OPTIONS.includes(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) fail(`--${name} needs a value`);
      args.add(name, value);
    } else {
      fail(`Unknown option --${name}`);
    }
  }
  return args;
}
