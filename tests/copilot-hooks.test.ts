// The GitHub Copilot CLI hooks (hooks/lib/copilot.mjs, selected by the `copilot` argument of the
// hook entry points). The decision is the shared one (gate.mjs) through the Claude adapter. These
// tests cover the Copilot wire format as measured on Copilot CLI 1.0.93 on Windows: the native
// camelCase payload, the refusal of the PascalCase payload, the output keys, the PowerShell
// rewrite, the exit codes, and the fail-closed paths. Everything runs against the fixture
// workspace and stubs; nothing reaches GitHub.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodePayload } from "../bin/payload.mjs";
import { contextLine } from "../gate.mjs";
import {
  budgetAnswer,
  handlePreToolUse,
  handleSessionStart,
  normalizeCall,
  SESSION_NOTE,
} from "../hooks/lib/copilot.mjs";
import { runGuardedHook } from "../hooks/lib/entry.mjs";
import { runtimeNamed } from "../hooks/lib/runtime.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";

// The payloads Copilot CLI 1.0.93 sends on Windows, as measured with a probe plugin. The
// measurement elided some values with an ellipsis; those are filled with plausible literals here,
// and every field name and shape is verbatim. `cwd` is the only value a test chooses.
const SESSION_ID = "7c1f0e52-2a8d-4f0e-9b1a-3d2c5e6f7a81";
const MEASURED = {
  // A PowerShell tool call, native camelCase payload (the preToolUse event key).
  powershellProbe: (cwd: string) => ({
    sessionId: SESSION_ID,
    timestamp: 1791497823504,
    cwd,
    toolName: "powershell",
    toolArgs: {
      command: 'Write-Output "probe one"',
      description: "Run probe one",
    },
  }),
  // The same, for the `gh api user --jq .login` call the rewrite must carry.
  powershellGhLogin: (cwd: string) => ({
    sessionId: SESSION_ID,
    timestamp: 1791497823611,
    cwd,
    toolName: "powershell",
    toolArgs: {
      command: "gh api user --jq .login",
      description: "Read the signed-in login",
    },
  }),
  // A file-read tool call. It never reaches this hook under the powershell|bash matcher.
  view: (cwd: string) => ({
    sessionId: SESSION_ID,
    timestamp: 1791497823702,
    cwd,
    toolName: "view",
    toolArgs: {
      path: join(cwd, "README.md"),
      view_range: [1, 10],
    },
  }),
  // The PascalCase payload Copilot sends under PascalCase event keys: the PowerShell tool is
  // reported as Claude's Bash.
  pascalProbe: (cwd: string) => ({
    hook_event_name: "PreToolUse",
    session_id: SESSION_ID,
    timestamp: "2026-10-06T12:00:00.000Z",
    cwd,
    tool_name: "Bash",
    tool_input: {
      command: 'Write-Output "probe one"',
      description: "Run probe one",
    },
  }),
  // The sessionStart payload.
  sessionStart: (cwd: string) => ({
    sessionId: SESSION_ID,
    timestamp: 1791497823800,
    cwd,
    source: "new",
    initialPrompt: "",
  }),
};

// A PreToolUse answer that rewrites the arguments.
type Rewrite = {
  permissionDecision: string;
  modifiedArgs: Record<string, unknown> & { command: string };
};

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };
const PRE_ENTRY = join(repoDir, "hooks", "pre-tool-use.mjs");
const SESSION_ENTRY = join(repoDir, "hooks", "session-start.mjs");

let ws = "";
const cwdOf = (rel: string) => join(ws, ...rel.split("/"));
const DEMO = "projects/repos/demo-repo";

before(() => {
  // The tests below assume the switch is unset, whatever the terminal that started them exports.
  delete process.env.AGENT_ACCESS_COPILOT_ASK;
  ws = tempDir("copilot-hooks-");
  buildWorkspace(ws, { level: "read" });
});

after(() => {
  if (ws) removeDir(ws);
});

// The payload for a shell call in the native shape, with the command and the tool's description.
function shellCall(
  tool: "bash" | "powershell",
  command: string,
  cwd: string | undefined,
) {
  const base = {
    sessionId: SESSION_ID,
    timestamp: 1791497823900,
    toolName: tool,
    toolArgs: { command, description: "d" },
  };
  return cwd === undefined ? base : { ...base, cwd };
}

function decide(input: unknown, level = "read") {
  writeCatalog(ws, level);
  return handlePreToolUse(input, { workspaceRoot: ws, env: TOKEN_ENV });
}

// The exact keys of a Copilot deny: nothing else is allowed.
function denied(out: Record<string, unknown> | null) {
  assert.ok(out, "expected a deny, got no answer");
  assert.deepEqual(Object.keys(out).sort(), [
    "permissionDecision",
    "permissionDecisionReason",
  ]);
  assert.equal(out.permissionDecision, "deny");
  return String(out.permissionDecisionReason);
}

// The payload the rewrite carries. It is the last single-quoted base64 piece of the command.
function rewrittenPayload(command: string) {
  const match = /'([A-Za-z0-9+/=]+)'\s*$/.exec(command);
  assert.ok(match, `no base64 payload at the end of: ${command}`);
  return decodePayload(match[1]);
}

const pushMain = (cwd: string | undefined) =>
  shellCall("powershell", "git push origin main", cwd);

test("a push to the organization main is denied from the measured PowerShell payload, and from the bash tool", async () => {
  const reason = denied(await decide(pushMain(cwdOf(DEMO)), "propose"));
  assert.match(
    reason,
    /agent-access: denied: demo-repo denies this command at level "propose"/,
  );
  const bash = denied(
    await decide(
      shellCall("bash", "git push origin main", cwdOf(DEMO)),
      "propose",
    ),
  );
  assert.match(bash, /denies this command at level "propose"/);
});

test("a push with a PowerShell-quoted remote, and a dry run of a push to the org main, are denied through PowerShell", async () => {
  denied(
    await decide(
      shellCall("powershell", "git push 'origin' main", cwdOf(DEMO)),
      "propose",
    ),
  );
  // The fixture's origin is the organization URL, so a dry run of a push to it is still a push.
  denied(
    await decide(
      shellCall(
        "powershell",
        "git push --dry-run origin HEAD:main",
        cwdOf(DEMO),
      ),
      "propose",
    ),
  );
});

test("a push to a branch on the organization remote that the level allows passes untouched", async () => {
  assert.equal(
    await decide(
      shellCall("powershell", "git push origin feat/x", cwdOf(DEMO)),
      "propose",
    ),
    null,
  );
  assert.equal(
    await decide(
      shellCall("bash", "git push origin feat/x", cwdOf(DEMO)),
      "propose",
    ),
    null,
  );
});

test("a measured command outside the fleet passes untouched, even a push to main", async () => {
  const outside = cwdOf("projects/other/x");
  assert.equal(
    await decide(MEASURED.powershellProbe(outside), "propose"),
    null,
  );
  assert.equal(await decide(pushMain(outside), "propose"), null);
  assert.equal(
    await decide(shellCall("bash", "git push origin main", outside), "propose"),
    null,
  );
});

test("a command that is not a write passes, and so does a PowerShell command with no working directory", async () => {
  assert.equal(await decide(shellCall("bash", "npm test", cwdOf(DEMO))), null);
  assert.equal(
    await decide(shellCall("powershell", "npm test", cwdOf(DEMO))),
    null,
  );
  assert.equal(
    await decide(MEASURED.powershellProbe(undefined as unknown as string)),
    null,
  );
});

test("a write with no working directory is denied", async () => {
  denied(await decide(pushMain(undefined)));
});

test("the measured PascalCase payload is denied on the Copilot path, for a write and for a read", async () => {
  const write = denied(
    await decide(MEASURED.pascalProbe(cwdOf(DEMO)), "propose"),
  );
  assert.match(write, /PascalCase payload/);
  assert.match(write, /camelCase event keys/);
  const read = denied(await decide(MEASURED.pascalProbe(cwdOf(DEMO))));
  assert.match(read, /PascalCase payload/);
});

test("a PascalCase payload from the PowerShell tool is denied with the same reason", async () => {
  const pascal = {
    ...MEASURED.pascalProbe(cwdOf(DEMO)),
    tool_name: "PowerShell",
  };
  assert.match(denied(await decide(pascal)), /PascalCase payload/);
});

test("the PreToolUse entry point answers the PascalCase refusal as JSON on stdout, with exit 0", () => {
  const result = spawnSync(process.execPath, [PRE_ENTRY, "copilot"], {
    windowsHide: true,
    input: JSON.stringify(MEASURED.pascalProbe(cwdOf(DEMO))),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /PascalCase payload/);
});

test("a call that names a tool other than the two shell tools is denied, and the reason names it", async () => {
  const reason = denied(await decide(MEASURED.view(cwdOf(DEMO))));
  assert.match(reason, /gates only the bash and powershell tools/);
  assert.match(reason, /"view"/);
  denied(
    await decide({
      sessionId: SESSION_ID,
      timestamp: 1,
      cwd: cwdOf(DEMO),
      toolName: "frobnicate",
      toolArgs: {},
    }),
  );
});

test("a malformed payload is an error, never a pass", async () => {
  await assert.rejects(
    handlePreToolUse(null, { workspaceRoot: ws }),
    /not an object/,
  );
  await assert.rejects(
    handlePreToolUse({ sessionId: SESSION_ID }, { workspaceRoot: ws }),
    /names no tool/,
  );
  await assert.rejects(
    handlePreToolUse(
      { toolName: "bash", toolArgs: {}, cwd: cwdOf(DEMO) },
      { workspaceRoot: ws },
    ),
    /no command string/,
  );
  await assert.rejects(
    handlePreToolUse(
      {
        toolName: "powershell",
        toolArgs: "git push origin main",
        cwd: cwdOf(DEMO),
      },
      { workspaceRoot: ws },
    ),
    /no command string/,
  );
});

test("the PreToolUse entry point exits 2 on a malformed payload, with the reason on stderr", () => {
  for (const input of [
    "{",
    "{}",
    JSON.stringify({ toolName: "bash", toolArgs: {} }),
  ]) {
    const result = spawnSync(process.execPath, [PRE_ENTRY, "copilot"], {
      windowsHide: true,
      input,
      encoding: "utf8",
    });
    assert.equal(result.status, 2, input);
    assert.match(result.stderr, /so the command is blocked/);
    assert.equal(result.stdout, "");
  }
});

test("the PreToolUse entry point answers a measured push to main as JSON on stdout, with exit 0", () => {
  const result = spawnSync(process.execPath, [PRE_ENTRY, "copilot"], {
    windowsHide: true,
    input: JSON.stringify(pushMain(undefined)),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.permissionDecision, "deny");
  assert.deepEqual(Object.keys(out).sort(), [
    "permissionDecision",
    "permissionDecisionReason",
  ]);
});

test("the PreToolUse entry point passes a measured command outside the fleet with no output", () => {
  const result = spawnSync(process.execPath, [PRE_ENTRY, "copilot"], {
    windowsHide: true,
    input: JSON.stringify(MEASURED.powershellProbe(tmpdir())),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("a PreToolUse entry point started with an unknown runtime fails closed", () => {
  const result = spawnSync(process.execPath, [PRE_ENTRY, "nonsense"], {
    windowsHide: true,
    input: JSON.stringify(MEASURED.powershellProbe(tmpdir())),
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /so the command is blocked/);
});

test("the measured PowerShell gh call is rewritten to the PowerShell form in modifiedArgs, with description preserved", async () => {
  const out = (await decide(
    MEASURED.powershellGhLogin(cwdOf(DEMO)),
  )) as Rewrite;
  assert.equal(out.permissionDecision, "allow");
  assert.deepEqual(Object.keys(out).sort(), [
    "modifiedArgs",
    "permissionDecision",
    "permissionDecisionReason",
  ]);
  // modifiedArgs is the measured toolArgs with only `command` replaced.
  assert.deepEqual(Object.keys(out.modifiedArgs), ["command", "description"]);
  assert.equal(out.modifiedArgs.description, "Read the signed-in login");
  const line = out.modifiedArgs.command;
  assert.match(
    line,
    /^& '[^']*node[^']*' '[^']*with-gh-token\.mjs' '[A-Za-z0-9+/=]+'$/,
  );
  assert.deepEqual(rewrittenPayload(line), {
    workspace: ws,
    repo: "demo-repo",
    command: "gh api user --jq .login",
    shell: "powershell",
  });
});

test("a PowerShell gh read with quotes, spaces, and a doubled single quote keeps the typed command exactly", async () => {
  const command = `gh search prs 'it''s a "test"' --jq .items`;
  const out = (await decide(
    shellCall("powershell", command, cwdOf(DEMO)),
  )) as Rewrite;
  assert.equal(out.permissionDecision, "allow");
  assert.equal(rewrittenPayload(out.modifiedArgs.command).command, command);
});

test("a PowerShell gh write is asked for, through the launcher, at a level that allows it", async () => {
  const out = (await decide(
    shellCall("powershell", "gh pr create --title x", cwdOf(DEMO)),
    "full",
  )) as Rewrite;
  assert.equal(out.permissionDecision, "ask");
  assert.match(out.modifiedArgs.command, /with-gh-token\.mjs'/);
});

test("a PowerShell gh write is denied at a level that does not allow it", async () => {
  denied(
    await decide(shellCall("powershell", "gh pr merge 1", cwdOf(DEMO)), "read"),
  );
});

test("a bash gh read from the Copilot bash tool is rewritten in POSIX form", async () => {
  const out = (await decide(
    shellCall("bash", "gh api user --jq .login", cwdOf(DEMO)),
  )) as Rewrite;
  assert.equal(out.permissionDecision, "allow");
  assert.match(
    out.modifiedArgs.command,
    /^'[^']*node[^']*' '[^']*with-gh-token\.mjs' '[A-Za-z0-9+/=]+'$/,
  );
  assert.deepEqual(rewrittenPayload(out.modifiedArgs.command), {
    workspace: ws,
    repo: "demo-repo",
    command: "gh api user --jq .login",
  });
});

test("the Claude adapter still denies a PowerShell gh call and says to use Bash", async () => {
  const { handlePreToolUse: claudePre } = await import(
    "../hooks/lib/claude.mjs"
  );
  writeCatalog(ws, "read");
  const out = await claudePre(
    {
      tool_name: "PowerShell",
      cwd: cwdOf(DEMO),
      tool_input: { command: "gh api user --jq .login" },
    },
    { workspaceRoot: ws, env: TOKEN_ENV },
  );
  assert.equal(out?.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    out?.hookSpecificOutput.permissionDecisionReason,
    /run this gh command with Bash, not PowerShell/,
  );
});

test("the measured sessionStart payload gets additionalContext for a fleet repository, and nothing elsewhere", async () => {
  writeCatalog(ws, "propose");
  assert.deepEqual(
    await handleSessionStart(MEASURED.sessionStart(cwdOf(DEMO)), {
      workspaceRoot: ws,
    }),
    {
      additionalContext: `${contextLine("demo-repo", "propose")} ${SESSION_NOTE}`,
    },
  );
  assert.equal(
    await handleSessionStart(MEASURED.sessionStart(cwdOf("projects/other/x")), {
      workspaceRoot: ws,
    }),
    null,
  );
});

test("the SessionStart entry point never blocks, and prints nothing for a malformed payload", () => {
  const result = spawnSync(process.execPath, [SESSION_ENTRY, "copilot"], {
    windowsHide: true,
    input: "{",
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("a killed Copilot PreToolUse worker denies a write in Copilot's shape and passes a read", () => {
  const killed = {
    error: { code: "ETIMEDOUT", message: "spawnSync ETIMEDOUT" },
    signal: "SIGTERM",
    status: null,
  };
  const spawn = (() => ({
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...killed,
  })) as never;

  const write: string[] = [];
  assert.equal(
    runGuardedHook({
      kind: "pre",
      runtime: "copilot",
      input: JSON.stringify(pushMain(cwdOf(DEMO))),
      spawn,
      stdout: (t) => write.push(t),
      stderr: () => {},
    }),
    0,
  );
  const answer = JSON.parse(write[0]);
  assert.equal(answer.permissionDecision, "deny");
  assert.deepEqual(Object.keys(answer).sort(), [
    "permissionDecision",
    "permissionDecisionReason",
  ]);

  const read: string[] = [];
  runGuardedHook({
    kind: "pre",
    runtime: "copilot",
    input: JSON.stringify(shellCall("bash", "ls", undefined)),
    spawn,
    stdout: (t) => read.push(t),
    stderr: () => {},
  });
  assert.deepEqual(read, []);
});

test("a Copilot PreToolUse worker that cannot be read is a deny, and an unknown runtime throws before a worker starts", () => {
  const budget = budgetAnswer(undefined, { blockOnError: true }) as Record<
    string,
    unknown
  >;
  assert.equal(budget.permissionDecision, "deny");
  assert.equal(
    budgetAnswer({ toolName: "powershell" }, { blockOnError: false }),
    null,
  );
  assert.equal(
    budgetAnswer(MEASURED.pascalProbe(cwdOf(DEMO)), { blockOnError: true })
      ?.permissionDecision,
    "deny",
  );
  assert.throws(
    () => runtimeNamed("nonsense"),
    /unknown hook runtime "nonsense"/,
  );
  assert.throws(
    () =>
      runGuardedHook({
        kind: "pre",
        runtime: "nonsense",
        input: JSON.stringify(shellCall("bash", "ls", undefined)),
        spawn: (() => {
          throw new Error("spawned");
        }) as never,
        stdout: () => {},
        stderr: () => {},
      }),
    /unknown hook runtime/,
  );
});

test("normalizeCall maps the native tool name to the dialect, and refuses a payload with no toolName", () => {
  assert.deepEqual(normalizeCall(MEASURED.powershellProbe("/w")), {
    tool_name: "PowerShell",
    tool_input: {
      command: 'Write-Output "probe one"',
      description: "Run probe one",
    },
    cwd: "/w",
  });
  assert.equal(normalizeCall(shellCall("bash", "x", "/w")).tool_name, "Bash");
  assert.throws(
    () => normalizeCall(MEASURED.pascalProbe("/w")),
    /names no tool/,
  );
});
