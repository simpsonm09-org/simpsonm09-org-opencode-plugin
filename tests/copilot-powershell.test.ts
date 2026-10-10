// The Copilot PowerShell rewrite, run for real on Windows. The Copilot adapter rewrites an allowed
// gh call from its PowerShell tool into a PowerShell line that starts the launcher. These tests
// run that line in powershell.exe, the way the PowerShell tool runs it, and the launcher runs the
// command under PowerShell with GH_TOKEN set. A stub gh.cmd on PATH records what it received.
// Nothing reaches GitHub, and the broker is the fixture's literal stub. Skipped off Windows.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS = process.platform === "win32";
const FIXTURE_TOKEN = "fixture-token-not-real";

let ws = "";
let copy = "";
let stubDir = "";
let outFile = "";
let demo = "";

before(() => {
  // The tests below assume the switch is unset, whatever the terminal that started them exports.
  delete process.env.AGENT_ACCESS_COPILOT_ASK;
  if (!WINDOWS) return;
  ws = tempDir("copilot-ps-");
  buildWorkspace(ws, { level: "read" });
  demo = join(ws, "projects", "repos", "demo-repo");

  // The plugin's runtime, copied under the workspace's worktrees: the layout the launcher trusts.
  copy = join(ws, "projects", "worktrees", "plugin-copy");
  mkdirSync(copy, { recursive: true });
  for (const entry of ["hooks", "lib", "bin", "gate.mjs", "access.mjs"]) {
    cpSync(join(repoDir, entry), join(copy, entry), { recursive: true });
  }

  stubDir = tempDir("copilot-ps-stub-");
  const stub = join(stubDir, "gh-stub.mjs");
  writeFileSync(
    stub,
    "import { writeFileSync } from 'node:fs';\n" +
      "writeFileSync(process.env.GH_STUB_OUT, JSON.stringify({ args: process.argv.slice(2), token: process.env.GH_TOKEN ?? null }));\n",
  );
  writeFileSync(
    join(stubDir, "gh.cmd"),
    `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`,
  );
  outFile = join(stubDir, "gh-out.json");
});

after(() => {
  if (ws) removeDir(ws);
  if (stubDir) removeDir(stubDir);
});

// Asks the copied adapter for the rewrite of one PowerShell gh call, then runs the rewritten
// line in powershell.exe from the fleet clone, with the stub gh first on PATH.
async function runFromCopilotPowerShell(command: string) {
  const { handlePreToolUse } = await import(
    pathToFileURL(join(copy, "hooks", "lib", "copilot.mjs")).href
  );
  writeCatalog(ws, "read");
  // The native camelCase payload Copilot CLI 1.0.93 sends for a PowerShell call (measured).
  const answer = (await handlePreToolUse(
    {
      sessionId: "7c1f0e52-2a8d-4f0e-9b1a-3d2c5e6f7a81",
      timestamp: 1791497823611,
      cwd: demo,
      toolName: "powershell",
      toolArgs: { command, description: "Run the gh call" },
    },
    { workspaceRoot: ws, env: {} },
  )) as { permissionDecision: string; modifiedArgs: { command: string } };
  assert.equal(answer.permissionDecision, "allow");

  rmSync(outFile, { force: true });
  const run = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(answer.modifiedArgs.command, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      cwd: demo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stubDir};${process.env.PATH ?? ""}`,
        GH_STUB_OUT: outFile,
      },
    },
  );
  const received = existsSync(outFile)
    ? JSON.parse(readFileSync(outFile, "utf8"))
    : null;
  return { status: run.status, stderr: run.stderr, received };
}

test("a PowerShell gh call with --jq .login runs through the launcher with the exact arguments and the token", {
  skip: !WINDOWS,
}, async () => {
  const run = await runFromCopilotPowerShell("gh api user --jq .login");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.received, {
    args: ["api", "user", "--jq", ".login"],
    token: FIXTURE_TOKEN,
  });
});

test("a PowerShell gh call with a doubled single quote and spaces passes the argument as PowerShell reads it", {
  skip: !WINDOWS,
}, async () => {
  const run = await runFromCopilotPowerShell(
    `gh search prs 'it''s a test' --jq .items`,
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.received?.args, [
    "search",
    "prs",
    "it's a test",
    "--jq",
    ".items",
  ]);
  assert.equal(run.received?.token, FIXTURE_TOKEN);
});

test("a PowerShell gh call with double quotes and spaces passes the argument as PowerShell reads it", {
  skip: !WINDOWS,
}, async () => {
  const run = await runFromCopilotPowerShell(`gh search prs "a b" --jq .items`);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.received?.args, [
    "search",
    "prs",
    "a b",
    "--jq",
    ".items",
  ]);
});
