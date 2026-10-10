import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PRE_TOOL_USE_BUDGET, SESSION_START_BUDGET } from "../lib/budget.mjs";
import { removeDir, tempDir } from "./support/fixture-workspace.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name: string) =>
  JSON.parse(readFileSync(join(root, name), "utf8"));

test("the Claude manifest is valid and matches the package", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  const pkg = readJson("package.json");

  assert.equal(manifest.name, "simpsonm09-org-ai-plugin");
  assert.equal(manifest.version, pkg.version);
  assert.ok(
    manifest.description?.length > 0,
    "the manifest needs a description",
  );
  assert.deepEqual(readdirSync(join(root, ".claude-plugin")), ["plugin.json"]);
});

test("hooks.json registers the PreToolUse and SessionStart hooks on existing scripts", () => {
  const { hooks } = readJson("hooks/hooks.json");

  const pre = hooks.PreToolUse;
  assert.equal(pre.length, 1);
  // The gate covers the Bash tool and the PowerShell tool, both with the command
  // in tool_input.command.
  assert.deepEqual(pre[0].matcher.split("|").sort(), ["Bash", "PowerShell"]);
  assert.equal(pre[0].hooks[0].type, "command");
  // A hook that runs past its timeout does not block the call, so the timeout must
  // be well above the gate's own bounded child and broker calls.
  assert.ok(
    pre[0].hooks[0].timeout >= 30 && pre[0].hooks[0].timeout <= 120,
    "PreToolUse has a bounded timeout",
  );
  assert.ok(
    hooks.SessionStart[0].hooks[0].timeout > 0,
    "SessionStart has a timeout",
  );

  const start = hooks.SessionStart;
  assert.equal(start.length, 1);
  assert.equal(start[0].hooks[0].type, "command");

  for (const entry of [pre[0], start[0]]) {
    const command: string = entry.hooks[0].command;
    const match = /"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(command);
    assert.ok(
      match,
      `command ${command} runs a script under CLAUDE_PLUGIN_ROOT`,
    );
    assert.ok(existsSync(join(root, match[1])), `${match[1]} is missing`);
  }
});

test("the Claude side ships with the layer and the package publish lists", () => {
  const layer = readJson("layer.json");
  const pkg = readJson("package.json");

  for (const entry of [
    ".claude-plugin",
    "hooks",
    "bin",
    "lib",
    "access.mjs",
    "gate.mjs",
  ]) {
    assert.ok(layer.files.includes(entry), `layer.json files lacks ${entry}`);
    assert.ok(pkg.files.includes(entry), `package.json files lacks ${entry}`);
  }
});

test("the shared skills directory is used in place, not copied under the plugin", () => {
  assert.equal(existsSync(join(root, ".claude-plugin", "skills")), false);
  assert.equal(existsSync(join(root, "hooks", "skills")), false);
  assert.ok(existsSync(join(root, "skills")));
});

test("each hook's internal budget is below its hooks.json timeout, and the outer kill is below the timeout too", () => {
  const hooks = readJson("hooks/hooks.json").hooks;
  const pre = hooks.PreToolUse[0].hooks[0].timeout * 1000;
  const start = hooks.SessionStart[0].hooks[0].timeout * 1000;
  assert.ok(
    PRE_TOOL_USE_BUDGET.budgetMs < PRE_TOOL_USE_BUDGET.killMs,
    "the internal budget ends before the outer kill",
  );
  assert.ok(
    PRE_TOOL_USE_BUDGET.killMs < pre,
    "the PreToolUse outer kill is below its hooks.json timeout",
  );
  assert.ok(
    SESSION_START_BUDGET.budgetMs < SESSION_START_BUDGET.killMs,
    "the SessionStart internal budget ends before the kill",
  );
  assert.ok(
    SESSION_START_BUDGET.killMs < start,
    "the SessionStart outer kill is below its hooks.json timeout",
  );
});

test("claude plugin validate accepts the plugin, when the CLI is installed", (t) => {
  // An isolated config directory for every call, so the user's own profile is never read or written.
  const config = tempDir("claude-config-");
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
  try {
    const probe = spawnSync("claude", ["--version"], {
      windowsHide: true,
      encoding: "utf8",
      shell: true,
      env,
      timeout: 60_000,
    });
    if (probe.status !== 0) return t.skip("the claude CLI is not installed");
    const result = spawnSync("claude", ["plugin", "validate", root], {
      windowsHide: true,
      encoding: "utf8",
      shell: true,
      env,
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Validation passed/);
  } finally {
    removeDir(config);
  }
});
