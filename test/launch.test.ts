import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  detectLauncher,
  launchTab,
  type ExecStep,
} from "../src/launch/index.ts";

const sampleReq = {
  cwd: "/tmp/repo-pr-638",
  label: "desk pr-638",
  argv: ["desk", "open", "638"],
};

const envKeys = [
  "HERDR_ENV",
  "TUIOS_ENV",
  "WEZTERM_PANE",
  "DESK_LAUNCH_DRY_RUN",
] as const;

type EnvKey = (typeof envKeys)[number];

const saved: Partial<Record<EnvKey, string | undefined>> = {};

function saveEnv(): void {
  for (const key of envKeys) {
    saved[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearLaunchEnv(): void {
  for (const key of envKeys) {
    delete process.env[key];
  }
}

function parseSteps(detail: string): ExecStep[] {
  return JSON.parse(detail) as ExecStep[];
}

describe("detectLauncher", () => {
  test("prefers herdr over tuios and wezterm", () => {
    assert.equal(
      detectLauncher({
        HERDR_ENV: "1",
        TUIOS_ENV: "1",
        WEZTERM_PANE: "42",
      }),
      "herdr",
    );
  });

  test("prefers tuios over wezterm when herdr is absent", () => {
    assert.equal(
      detectLauncher({
        TUIOS_ENV: "1",
        WEZTERM_PANE: "42",
      }),
      "tuios",
    );
  });

  test("uses wezterm when only WEZTERM_PANE is set", () => {
    assert.equal(detectLauncher({ WEZTERM_PANE: "99" }), "wezterm");
  });

  test("falls back to print with no multiplexer env", () => {
    assert.equal(detectLauncher({}), "print");
  });
});

describe("launchTab dry run", () => {
  beforeEach(() => {
    saveEnv();
    clearLaunchEnv();
    process.env.DESK_LAUNCH_DRY_RUN = "1";
  });

  afterEach(() => {
    restoreEnv();
  });

  test("herdr plans list, create, and pane run", async () => {
    process.env.HERDR_ENV = "1";
    const result = await launchTab(sampleReq);
    assert.equal(result.via, "herdr");
    const steps = parseSteps(result.detail);
    assert.deepEqual(steps[0], { cmd: "herdr", args: ["tab", "list"] });
    assert.deepEqual(steps[1], {
      cmd: "herdr",
      args: [
        "tab",
        "create",
        "--cwd",
        sampleReq.cwd,
        "--label",
        sampleReq.label,
        "--focus",
      ],
    });
    assert.deepEqual(steps[2], {
      cmd: "herdr",
      args: ["pane", "run", "<root_pane>", ...sampleReq.argv],
    });
  });

  test("tuios plans list-windows and new-window", async () => {
    process.env.TUIOS_ENV = "1";
    const result = await launchTab(sampleReq);
    assert.equal(result.via, "tuios");
    const steps = parseSteps(result.detail);
    assert.deepEqual(steps[0], {
      cmd: "tuios",
      args: ["list-windows", "--json"],
    });
    assert.deepEqual(steps[1], {
      cmd: "tuios",
      args: [
        "new-window",
        sampleReq.label,
        "--cwd",
        sampleReq.cwd,
        "--",
        ...sampleReq.argv,
      ],
    });
  });

  test("wezterm plans spawn and set-tab-title", async () => {
    process.env.WEZTERM_PANE = "pane-1";
    const result = await launchTab(sampleReq);
    assert.equal(result.via, "wezterm");
    const steps = parseSteps(result.detail);
    assert.deepEqual(steps[0], {
      cmd: "wezterm",
      args: ["cli", "spawn", "--cwd", sampleReq.cwd, "--", ...sampleReq.argv],
    });
    assert.deepEqual(steps[1], {
      cmd: "wezterm",
      args: [
        "cli",
        "set-tab-title",
        "--pane-id",
        "<pane-id>",
        sampleReq.label,
      ],
    });
  });

  test("print returns a copy-pasteable shell command", async () => {
    const result = await launchTab(sampleReq);
    assert.equal(result.via, "print");
    assert.equal(
      result.detail,
      "cd /tmp/repo-pr-638 && desk open 638",
    );
  });
});
