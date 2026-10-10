// The Claude Code hook (hooks/lib/claude.mjs) and its two entry points. The decision is the
// shared one (gate.mjs); these tests cover the mapping onto the PreToolUse protocol, the
// Claude-only rules (launcher program, PowerShell gh, read-only allow), and the fail-closed
// paths. Hook scripts are driven with JSON on stdin, as Claude Code drives them.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodePayload } from "../bin/payload.mjs";
import { contextLine } from "../gate.mjs";
import {
  budgetAnswer,
  handlePreToolUse,
  handleSessionStart,
  runHook,
} from "../hooks/lib/claude.mjs";
import {
  displayCommand,
  readOnlyGh,
  runsLauncher,
} from "../hooks/lib/commands.mjs";
import { BudgetExhausted } from "../lib/budget.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(here, "..");

const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };

let ws = "";
const cwdOf = (rel: string) => join(ws, ...rel.split("/"));

before(() => {
  ws = tempDir("claude-hooks-");
  buildWorkspace(ws, { level: "read" });
});

after(() => {
  if (ws) removeDir(ws);
});

type Output = { hookSpecificOutput: Record<string, unknown> } | null;

function pre(
  tool: string,
  command: string,
  cwd: string | undefined,
  level = "read",
): Promise<Output> {
  writeCatalog(ws, level);
  const input: Record<string, unknown> = {
    tool_name: tool,
    tool_input: { command, description: "d" },
  };
  if (cwd !== undefined) input.cwd = cwd;
  return handlePreToolUse(input, { workspaceRoot: ws, env: TOKEN_ENV });
}

function bashPre(
  command: string,
  rel = "projects/repos/demo-repo",
  level = "read",
) {
  return pre("Bash", command, cwdOf(rel), level);
}

test("a denied write is denied with the gate's reason", async () => {
  const out = await bashPre("gh pr merge 1");
  assert.equal(out?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    out?.hookSpecificOutput.permissionDecisionReason,
    /agent-access: denied: demo-repo denies this command at level "read"/,
  );
});

test("a denied push to the organization main is denied at a propose level", async () => {
  const out = await bashPre(
    "git push origin main",
    "projects/repos/demo-repo",
    "propose",
  );
  assert.equal(out?.hookSpecificOutput.permissionDecision, "deny");
});

test("a push to a fork remote is out of scope and passes untouched", async () => {
  assert.equal(
    await bashPre(
      "git push origin main",
      "projects/repos/fork-repo",
      "propose",
    ),
    null,
  );
});

test("a read-only gh call is rewritten to the launcher and allowed, with the payload intact", async () => {
  const out = await bashPre("gh pr view 1");
  const hook = out?.hookSpecificOutput;
  assert.equal(hook.permissionDecision, "allow");
  assert.equal(
    hook.updatedInput.description,
    "d",
    "every other tool input field is carried over",
  );
  const command = hook.updatedInput.command as string;
  assert.match(command, /with-gh-token\.mjs/);
  const payload = decodePayload(
    /'([A-Za-z0-9+/=]+)'$/.exec(command)?.[1] ?? "",
  );
  assert.deepEqual(payload, {
    workspace: ws,
    repo: "demo-repo",
    command: "gh pr view 1",
  });
});

test("an executable spelling of gh is rewritten through the launcher, and the payload keeps the typed command", async () => {
  const out = await bashPre("gh.exe pr view 1");
  const hook = out?.hookSpecificOutput;
  assert.equal(hook.permissionDecision, "allow");
  const command = hook.updatedInput.command as string;
  const payload = decodePayload(
    /'([A-Za-z0-9+/=]+)'$/.exec(command)?.[1] ?? "",
  );
  assert.deepEqual(payload, {
    workspace: ws,
    repo: "demo-repo",
    command: "gh.exe pr view 1",
  });
});

test("an executable spelling of gh write is denied at a level that does not allow it", async () => {
  const out = await bashPre(
    '"C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 1',
  );
  assert.equal(out?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    out?.hookSpecificOutput.permissionDecisionReason,
    /demo-repo denies this command at level "read"/,
  );
});

test("a gh write is rewritten to the launcher and asks", async () => {
  const out = await bashPre(
    "gh pr create --title x",
    "projects/repos/demo-repo",
    "full",
  );
  assert.equal(out?.hookSpecificOutput.permissionDecision, "ask");
  assert.match(
    out?.hookSpecificOutput.updatedInput.command,
    /with-gh-token\.mjs/,
  );
});

test("a gh call in a worktree is gated and rewritten like its clone", async () => {
  const out = await bashPre("gh pr view 1", "projects/worktrees/wt-demo");
  assert.equal(out?.hookSpecificOutput.permissionDecision, "allow");
  const denied = await bashPre("gh pr merge 1", "projects/worktrees/wt-demo");
  assert.equal(denied?.hookSpecificOutput.permissionDecision, "deny");
});

test("a command the gate does not govern passes untouched", async () => {
  assert.equal(await bashPre("npm test"), null);
  assert.equal(await bashPre("git status"), null);
});

test("a command outside the fleet passes untouched, even a push", async () => {
  assert.equal(
    await pre("Bash", "git push origin main", cwdOf("projects/other/x")),
    null,
  );
});

test("a gh call from PowerShell is refused with a hint to use the Bash tool", async () => {
  const out = await pre(
    "PowerShell",
    "gh pr view 1",
    cwdOf("projects/repos/demo-repo"),
  );
  assert.equal(out?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    out?.hookSpecificOutput.permissionDecisionReason,
    /run this gh command with Bash, not PowerShell/,
  );
});

test("a denied PowerShell write is denied, and an ungoverned PowerShell command passes", async () => {
  const denied = await pre(
    "PowerShell",
    "git push origin main",
    cwdOf("projects/repos/demo-repo"),
  );
  assert.equal(denied?.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(
    await pre("PowerShell", "npm test", cwdOf("projects/repos/demo-repo")),
    null,
  );
});

test("a call to the launcher as a program is denied, in any simple command", () => {
  const launcher = join(repoDir, "bin", "with-gh-token.mjs");
  for (const command of [
    `node "${launcher}" abc`,
    `"${launcher}" abc`,
    `FOO=1 node ${launcher} abc`,
    `cd x && node with-gh-token.mjs abc`,
    `echo ok; with-gh-token.mjs abc`,
  ]) {
    assert.equal(runsLauncher(command), true, command);
  }
});

test("naming the launcher as an argument does not run it", () => {
  for (const command of [
    "echo with-gh-token",
    "cat bin/with-gh-token.mjs",
    "grep -r with-gh-token .",
  ]) {
    assert.equal(runsLauncher(command), false, command);
  }
});

test("a direct launcher call is denied by the hook", async () => {
  const launcher = join(repoDir, "bin", "with-gh-token.mjs");
  const out = await pre(
    "Bash",
    `node "${launcher}" abc`,
    cwdOf("projects/repos/demo-repo"),
  );
  assert.equal(out?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    out?.hookSpecificOutput.permissionDecisionReason,
    /not for direct use/,
  );
});

test("readOnlyGh allows the listed read verbs and asks for everything else", () => {
  const reads = [
    "gh pr view 1",
    "gh pr list --json title",
    "gh pr checks 1",
    "gh pr diff 1",
    "gh issue list",
    "gh run watch 1",
    "gh repo view",
    "gh release list",
    "gh workflow view ci.yml",
    "gh search prs x",
    "gh status",
    "gh api repos/o/r",
    `gh api repos/o/r --jq '.name'`,
  ];
  for (const command of reads) assert.equal(readOnlyGh(command), true, command);

  const asks = [
    "gh pr merge 1",
    "gh pr create --title x",
    "gh repo delete o/r --yes",
    "gh workflow run ci.yml",
    "gh api -X POST repos/o/r",
    "gh api -XPOST repos/o/r",
    "gh api --method=DELETE repos/o/r",
    "gh api repos/o/r -f a=b",
    "gh api repos/o/r --input body.json",
    "gh pr list; echo x",
    "gh pr list | jq .",
    "gh pr view $(whoami)",
    "gh pr view 1 > out.txt",
    "gh pr view 1 && rm -rf x",
    "gh -R o/r pr view 1",
  ];
  for (const command of asks) assert.equal(readOnlyGh(command), false, command);
});

test("readOnlyGh reads an executable spelling of gh as the plain name", () => {
  assert.equal(readOnlyGh("gh.exe pr view 1"), true);
  assert.equal(
    readOnlyGh('"C:\\Program Files\\GitHub CLI\\gh.exe" pr list'),
    true,
  );
  assert.equal(readOnlyGh("GH.EXE pr merge 1"), false);
});

test("the launcher's program check reads the Windows spelling of node and the launcher", () => {
  const launcher = join(repoDir, "bin", "with-gh-token.mjs");
  assert.equal(runsLauncher(`NODE.EXE "${launcher}" abc`), true);
  assert.equal(runsLauncher("NODE.EXE tool.mjs"), false);
});

test("a read with no working directory passes, and a write with none is denied", async () => {
  assert.equal(await pre("Bash", "ls -la", undefined), null);
  const denied = await pre("Bash", "git push origin main", undefined);
  assert.equal(denied?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    denied?.hookSpecificOutput.permissionDecisionReason,
    /could not determine the working directory/,
  );
});

test("a write with a non-string working directory is denied the same way", async () => {
  const denied = await pre("Bash", "gh pr merge 1", 5 as unknown as string);
  assert.equal(denied?.hookSpecificOutput.permissionDecision, "deny");
});

test("the hook is inert for an unknown tool", async () => {
  assert.equal(
    await pre(
      "Read",
      "git push origin main",
      cwdOf("projects/repos/demo-repo"),
    ),
    null,
  );
});

test("a plugin outside every trusted layout denies a write and passes a read", async () => {
  // Copy the runtime into a directory that is neither .opencode/plugins nor projects/<kind>,
  // then load it from there. Its own location then trusts no workspace.
  const outside = tempDir("claude-untrusted-");
  const copy = join(outside, "cache", "plugin");
  mkdirSync(copy, { recursive: true });
  for (const entry of ["hooks", "lib", "bin", "gate.mjs", "access.mjs"]) {
    cpSync(join(repoDir, entry), join(copy, entry), { recursive: true });
  }
  try {
    const module = await import(
      pathToFileURL(join(copy, "hooks", "lib", "claude.mjs")).href
    );
    const cwd = cwdOf("projects/repos/demo-repo");
    const write = await module.handlePreToolUse(
      {
        tool_name: "Bash",
        cwd,
        tool_input: { command: "git push origin main" },
      },
      {},
    );
    assert.equal(write?.hookSpecificOutput.permissionDecision, "deny");
    assert.match(
      write?.hookSpecificOutput.permissionDecisionReason,
      /trusted workspace layout/,
    );
    assert.equal(
      await module.handlePreToolUse(
        { tool_name: "Bash", cwd, tool_input: { command: "ls" } },
        {},
      ),
      null,
    );
  } finally {
    removeDir(outside);
  }
});

test("the SessionStart line names the repository and its level, and a non-fleet session gets nothing", async () => {
  writeCatalog(ws, "propose");
  const started = await handleSessionStart(
    { cwd: cwdOf("projects/repos/demo-repo") },
    { workspaceRoot: ws },
  );
  assert.equal(started?.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(
    started?.hookSpecificOutput.additionalContext,
    contextLine("demo-repo", "propose"),
  );
  assert.equal(
    await handleSessionStart(
      { cwd: cwdOf("projects/other/x") },
      { workspaceRoot: ws },
    ),
    null,
  );
});

test("an internal failure in a PreToolUse run exits 2 with a stderr reason", async () => {
  const stderr: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await runHook(
      async () => {
        throw new Error("boom");
      },
      {
        blockOnError: true,
        input: '{"tool_name":"Bash","tool_input":{"command":"ls"}}',
      },
    );
    assert.equal(process.exitCode, 2);
    assert.match(stderr.join(""), /could not evaluate this command \(boom\)/);
  } finally {
    process.stderr.write = original;
    process.exitCode = 0;
  }
});

test("malformed stdin in a PreToolUse run exits 2", async () => {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await runHook(async () => null, { blockOnError: true, input: "not json" });
    assert.equal(process.exitCode, 2);
  } finally {
    process.stderr.write = original;
    process.exitCode = 0;
  }
});

test("a PreToolUse run that runs out of time denies a write and passes a read", async () => {
  const outputs: string[] = [];
  const never = () => new Promise<null>(() => {});
  await runHook(never, {
    blockOnError: true,
    budgetMs: 20,
    input:
      '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}',
    write: (text: string) => outputs.push(text),
  });
  assert.equal(
    JSON.parse(outputs[0]).hookSpecificOutput.permissionDecision,
    "deny",
  );
  assert.equal(process.exitCode, 0);

  outputs.length = 0;
  await runHook(never, {
    blockOnError: true,
    budgetMs: 20,
    input: '{"tool_name":"Bash","tool_input":{"command":"ls"}}',
    write: (text: string) => outputs.push(text),
  });
  assert.equal(outputs.length, 0);
});

test("the PreToolUse entry point blocks a write with no working directory, with JSON on stdout", () => {
  const script = join(repoDir, "hooks", "pre-tool-use.mjs");
  const result = spawnSync(process.execPath, [script], {
    windowsHide: true,
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(
    JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,
    "deny",
  );
});

test("the PreToolUse entry point exits 2 on malformed stdin", () => {
  const script = join(repoDir, "hooks", "pre-tool-use.mjs");
  const result = spawnSync(process.execPath, [script], {
    windowsHide: true,
    input: "{",
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /so the command is blocked/);
});

test("the SessionStart entry point never blocks a session", () => {
  const script = join(repoDir, "hooks", "session-start.mjs");
  const result = spawnSync(process.execPath, [script], {
    windowsHide: true,
    input: "{",
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
});

test("an ask prompt's reason shows the repository, its level, and the command the human approves", async () => {
  const out = await bashPre(
    "gh pr create --title x",
    "projects/repos/demo-repo",
    "full",
  );
  const reason = out?.hookSpecificOutput.permissionDecisionReason as string;
  assert.match(reason, /demo-repo runs this gh command at level "full"/);
  assert.match(reason, /gh pr create --title x$/);
});

test("displayCommand strips control characters and cuts a long command", () => {
  assert.equal(displayCommand("gh a\u0007\nb"), "gh a b");
  const shown = displayCommand(`gh api ${"x".repeat(500)}`);
  assert.equal(shown.length, 303);
  assert.ok(shown.endsWith("..."));
});

test("a malformed call is an error, not a pass", async () => {
  await assert.rejects(
    handlePreToolUse(
      { tool_name: "Bash", tool_input: {} },
      { workspaceRoot: ws },
    ),
    /no command string/,
  );
  await assert.rejects(
    handlePreToolUse(
      { tool_name: "Bash", tool_input: { command: 5 } },
      { workspaceRoot: ws },
    ),
    /no command string/,
  );
  await assert.rejects(
    handlePreToolUse(null, { workspaceRoot: ws }),
    /not an object/,
  );
});

test("a malformed PreToolUse call exits 2 through runHook", async () => {
  const stderr: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await runHook(handlePreToolUse, {
      blockOnError: true,
      input: '{"tool_name":"PowerShell","tool_input":{}}',
    });
    assert.equal(process.exitCode, 2);
  } finally {
    process.stderr.write = original;
    process.exitCode = 0;
  }
});

test("a call that runs out of budget gets the one rule: a write is denied, a read passes", () => {
  const writeCall = {
    tool_name: "Bash",
    tool_input: { command: "git push origin main" },
  };
  const readCall = { tool_name: "Bash", tool_input: { command: "ls" } };
  assert.equal(
    budgetAnswer(writeCall, { blockOnError: true })?.hookSpecificOutput
      .permissionDecision,
    "deny",
  );
  assert.equal(budgetAnswer(readCall, { blockOnError: true }), null);
  assert.equal(
    budgetAnswer(writeCall, { blockOnError: false }),
    null,
    "SessionStart has nothing to answer",
  );
  assert.equal(
    budgetAnswer(undefined, { blockOnError: true })?.hookSpecificOutput
      .permissionDecision,
    "deny",
    "unreadable input is a write",
  );
});

test("a handler that reports the budget as exhausted gets the same rule through runHook", async () => {
  const outputs: string[] = [];
  await runHook(
    async () => {
      throw new BudgetExhausted();
    },
    {
      blockOnError: true,
      input:
        '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}',
      write: (text: string) => outputs.push(text),
    },
  );
  assert.equal(
    JSON.parse(outputs[0]).hookSpecificOutput.permissionDecision,
    "deny",
  );
  assert.equal(process.exitCode, 0);
  outputs.length = 0;
  await runHook(
    async () => {
      throw new BudgetExhausted();
    },
    {
      blockOnError: true,
      input: '{"tool_name":"Bash","tool_input":{"command":"ls"}}',
      write: (text: string) => outputs.push(text),
    },
  );
  assert.equal(outputs.length, 0);
  assert.equal(process.exitCode, 0);
});

test("with git missing from PATH, the hook denies a write in a worktree and passes a read", async () => {
  const worktree = cwdOf("projects/worktrees/wt-demo");
  const emptyPath = tempDir("claude-empty-path-");
  const savedPath = process.env.PATH;
  process.env.PATH = emptyPath;
  try {
    writeCatalog(ws, "propose");
    const write = await handlePreToolUse(
      {
        tool_name: "Bash",
        cwd: worktree,
        tool_input: { command: "git push origin main" },
      },
      { workspaceRoot: ws, env: TOKEN_ENV },
    );
    assert.equal(write?.hookSpecificOutput.permissionDecision, "deny");
    assert.match(
      write?.hookSpecificOutput.permissionDecisionReason,
      /could not be resolved to a fleet repository/,
    );
    assert.equal(
      await handlePreToolUse(
        {
          tool_name: "Bash",
          cwd: worktree,
          tool_input: { command: "npm test" },
        },
        { workspaceRoot: ws, env: TOKEN_ENV },
      ),
      null,
    );
  } finally {
    process.env.PATH = savedPath;
    removeDir(emptyPath);
  }
});
