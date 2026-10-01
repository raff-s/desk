import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface TabRequest {
  cwd: string;
  label: string;
  argv: string[];
}

export interface TabResult {
  via: "herdr" | "tuios" | "wezterm" | "print";
  detail: string;
}

export interface ExecStep {
  cmd: string;
  args: string[];
}

type Via = TabResult["via"];

function isDryRun(): boolean {
  return process.env.DESK_LAUNCH_DRY_RUN === "1";
}

export function detectLauncher(env: NodeJS.ProcessEnv = process.env): Via {
  if (env.HERDR_ENV === "1") {
    return "herdr";
  }
  if (env.TUIOS_ENV === "1") {
    return "tuios";
  }
  const pane = env.WEZTERM_PANE;
  if (pane !== undefined && pane !== "") {
    return "wezterm";
  }
  return "print";
}

function formatSteps(steps: ExecStep[]): string {
  return JSON.stringify(steps);
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function formatPrintCommand(req: TabRequest): string {
  const run = req.argv.map(shellQuote).join(" ");
  return `cd ${shellQuote(req.cwd)} && ${run}`;
}

async function runStep(
  steps: ExecStep[],
  cmd: string,
  args: string[],
): Promise<string> {
  steps.push({ cmd, args });
  if (isDryRun()) {
    return "";
  }
  const { stdout } = await execFile(cmd, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

interface HerdrTabListResult {
  result?: {
    tabs?: Array<{ label: string; tab_id: string }>;
  };
}

interface HerdrTabCreateResult {
  result?: {
    root_pane?: string;
    tab?: string;
  };
}

interface TuiosListWindowsResult {
  windows?: Array<{ name?: string; window_id: string }>;
}

async function launchHerdr(req: TabRequest): Promise<TabResult> {
  const steps: ExecStep[] = [];
  const listOut = await runStep(steps, "herdr", ["tab", "list"]);
  let existingTabId: string | undefined;

  if (!isDryRun() && listOut.trim() !== "") {
    const parsed = JSON.parse(listOut) as HerdrTabListResult;
    const match = parsed.result?.tabs?.find((t) => t.label === req.label);
    existingTabId = match?.tab_id;
  }

  if (existingTabId !== undefined) {
    await runStep(steps, "herdr", ["tab", "focus", existingTabId]);
    return { via: "herdr", detail: formatSteps(steps) };
  }

  const createArgs = [
    "tab",
    "create",
    "--cwd",
    req.cwd,
    "--label",
    req.label,
    "--focus",
  ];
  const createOut = await runStep(steps, "herdr", createArgs);

  let rootPane = "<root_pane>";
  if (!isDryRun()) {
    const created = JSON.parse(createOut) as HerdrTabCreateResult;
    rootPane = created.result?.root_pane ?? rootPane;
    if (rootPane === "<root_pane>") {
      throw new Error("herdr tab create did not return root_pane");
    }
  }

  await runStep(steps, "herdr", ["pane", "run", rootPane, ...req.argv]);
  return { via: "herdr", detail: formatSteps(steps) };
}

async function launchTuios(req: TabRequest): Promise<TabResult> {
  const steps: ExecStep[] = [];
  const listOut = await runStep(steps, "tuios", ["list-windows", "--json"]);
  let hasExisting = false;

  if (!isDryRun() && listOut.trim() !== "") {
    const parsed = JSON.parse(listOut) as TuiosListWindowsResult;
    hasExisting =
      parsed.windows?.some((w) => w.name === req.label) ?? false;
  }

  if (hasExisting) {
    await runStep(steps, "tuios", ["focus-window", req.label]);
    return { via: "tuios", detail: formatSteps(steps) };
  }

  const newWindowArgs = [
    "new-window",
    req.label,
    "--cwd",
    req.cwd,
    "--",
    ...req.argv,
  ];
  await runStep(steps, "tuios", newWindowArgs);
  return { via: "tuios", detail: formatSteps(steps) };
}

async function launchWezterm(req: TabRequest): Promise<TabResult> {
  const steps: ExecStep[] = [];
  const spawnOut = await runStep(steps, "wezterm", [
    "cli",
    "spawn",
    "--cwd",
    req.cwd,
    "--",
    ...req.argv,
  ]);

  const paneId = isDryRun() ? "<pane-id>" : spawnOut.trim();
  if (!isDryRun() && paneId === "") {
    throw new Error("wezterm cli spawn did not return a pane id");
  }

  await runStep(steps, "wezterm", [
    "cli",
    "set-tab-title",
    "--pane-id",
    paneId,
    req.label,
  ]);
  return { via: "wezterm", detail: formatSteps(steps) };
}

export async function launchTab(req: TabRequest): Promise<TabResult> {
  const via = detectLauncher();
  switch (via) {
    case "herdr":
      return launchHerdr(req);
    case "tuios":
      return launchTuios(req);
    case "wezterm":
      return launchWezterm(req);
    case "print":
      return { via: "print", detail: formatPrintCommand(req) };
  }
}
