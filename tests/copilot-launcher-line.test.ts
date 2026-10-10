// A launcher line the model wrote itself. In a live Copilot CLI 1.0.93 run the model saw two of its
// gh calls shown in rewritten form, and then composed launcher lines by hand, with its own base64.
// The Copilot hook answers such a line with the plain command its payload carries, decided from
// scratch in the current call. Nothing else in the line is trusted: its node path, launcher path,
// and the payload's workspace, repo, and shell are discarded. Fixture workspace and stubs only.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { decodePayload } from "../bin/payload.mjs";
import {
  handlePreToolUse as claudePreToolUse,
  launcherLinePayload,
} from "../hooks/lib/claude.mjs";
import { handlePreToolUse, SESSION_NOTE } from "../hooks/lib/copilot.mjs";
import {
  buildWorkspace,
  ORG_URL,
  removeDir,
  tempDir,
  writeCatalog,
} from "./support/fixture-workspace.mjs";

const TOKEN_ENV = { CLAUDE_CODE_GIT_BASH_PATH: process.execPath };
const LAUNCHER_DENIAL =
  "agent-access: denied: the GitHub token launcher is not for direct use";
const WRAPPED_DENIAL =
  'agent-access: denied: do not call the GitHub token launcher yourself; run the plain command (for example "gh pr list") and the gate adds the token';

// The two payloads the model composed in the live run, verbatim. Their workspace and repo are
// wrong for this checkout, and the hook must not use them.
const LIVE_WRONG_REPO = String.raw`{"workspace":"D:\\dev\\simpsonm09","repo":"simpson09-maxstack","command":"gh repo view simpson09-org/simpsonm09-maxstack --json name --jq .name","shell":"powershell"}`;
const LIVE_PUSH = String.raw`{"workspace":"D:\\dev\\simpsonm09","repo":"simpson09-maxstack","command":"git push --dry-run upstream HEAD:main","shell":"powershell"}`;

// The wrapper's own paths, as the live model wrote them. Discarded, so they only need the shape.
const NODE = String.raw`C:\Program Files\nodejs\node.exe`;
const LAUNCHER = String.raw`D:\dev\simpsonm09\projects\worktrees\simpsonm09-org-ai-plugin-copilot\bin\with-gh-token.mjs`;
const NODE_POSIX = "/c/Program Files/nodejs/node.exe";
const LAUNCHER_POSIX =
  "/d/dev/simpsonm09/projects/worktrees/simpsonm09-org-ai-plugin-copilot/bin/with-gh-token.mjs";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const wrappedPs = (json: string) => `& '${NODE}' '${LAUNCHER}' '${b64(json)}'`;
const wrappedBash = (json: string) =>
  `'${NODE_POSIX}' '${LAUNCHER_POSIX}' '${b64(json)}'`;
const plainJson = (command: string) => JSON.stringify({ command });

let ws = "";
let demo = "";
const cwdOf = (rel: string) => join(ws, ...rel.split("/"));

before(() => {
  // The tests below assume the switch is unset, whatever the terminal that started them exports.
  delete process.env.AGENT_ACCESS_COPILOT_ASK;
  ws = tempDir("copilot-launcher-line-");
  buildWorkspace(ws, { level: "read" });
  demo = cwdOf("projects/repos/demo-repo");
  // The organization remote, so a push to `upstream` is a push to the protected repository.
  execFileSync("git", ["-C", demo, "remote", "add", "upstream", ORG_URL], {
    windowsHide: true,
  });
});

after(() => {
  if (ws) removeDir(ws);
});

// The hook's answer for one native Copilot call at a level.
function answer(
  tool: "bash" | "powershell",
  command: string,
  level = "read",
  cwd: string = demo,
) {
  writeCatalog(ws, level);
  return handlePreToolUse(
    {
      sessionId: "7c1f0e52-2a8d-4f0e-9b1a-3d2c5e6f7a81",
      timestamp: 1791497823611,
      cwd,
      toolName: tool,
      toolArgs: { command, description: "d" },
    },
    { workspaceRoot: ws, env: TOKEN_ENV },
  ) as Promise<
    | (Record<string, unknown> & {
        permissionDecision?: string;
        permissionDecisionReason?: string;
        modifiedArgs?: Record<string, string>;
      })
    | null
  >;
}

// The plain command a fresh rewrite carries, with its payload decoded.
function rewrittenPayload(command: string) {
  const match = /'([A-Za-z0-9+/=]+)'\s*$/.exec(command);
  assert.ok(match, `no base64 payload at the end of: ${command}`);
  return decodePayload(match[1]);
}

function assertDenied(out: Record<string, unknown> | null, reason: string) {
  assert.ok(out, "expected a denial");
  assert.deepEqual(Object.keys(out).sort(), [
    "permissionDecision",
    "permissionDecisionReason",
  ]);
  assert.equal(out.permissionDecision, "deny");
  assert.equal(out.permissionDecisionReason, reason);
}

test("a wrapped gh call whose payload names a wrong repo is rewritten for the current repo", async () => {
  const out = await answer("powershell", wrappedPs(LIVE_WRONG_REPO), "read");
  assert.equal(out?.permissionDecision, "allow");
  assert.deepEqual(Object.keys(out?.modifiedArgs).sort(), [
    "command",
    "description",
  ]);
  assert.equal(out?.modifiedArgs.description, "d");
  // The fresh rewrite is ours: this checkout's workspace and repo, and the plain command.
  assert.deepEqual(rewrittenPayload(out?.modifiedArgs.command), {
    workspace: ws,
    repo: "demo-repo",
    command:
      "gh repo view simpson09-org/simpsonm09-maxstack --json name --jq .name",
    shell: "powershell",
  });
});

test("a wrapped gh auth status gets exactly what a plain gh auth status gets", async () => {
  const plain = await answer("powershell", "gh auth status", "read");
  const wrapped = await answer(
    "powershell",
    wrappedPs(plainJson("gh auth status")),
    "read",
  );
  assert.ok(plain?.modifiedArgs, "a plain gh call is rewritten");
  assert.deepEqual(wrapped, plain);
});

test("a wrapped git push --dry-run to the organization remote is denied at propose", async () => {
  const out = await answer("powershell", wrappedPs(LIVE_PUSH), "propose");
  assert.equal(out?.permissionDecision, "deny");
  assert.match(
    out?.permissionDecisionReason,
    /demo-repo denies this command at level "propose"/,
  );
  assert.deepEqual(Object.keys(out).sort(), [
    "permissionDecision",
    "permissionDecisionReason",
  ]);
});

test("a wrapped branch push is denied, and the model is told to type the plain command", async () => {
  assertDenied(
    await answer(
      "powershell",
      wrappedPs(plainJson("git push origin feat/x")),
      "propose",
    ),
    WRAPPED_DENIAL,
  );
});

test("a wrapped Bash branch push is denied the same way, and a wrapped Bash gh read is rewritten in POSIX form", async () => {
  assertDenied(
    await answer(
      "bash",
      wrappedBash(plainJson("git push origin feat/x")),
      "propose",
    ),
    WRAPPED_DENIAL,
  );

  const read = await answer("bash", wrappedBash(LIVE_WRONG_REPO), "read");
  assert.equal(read?.permissionDecision, "allow");
  assert.match(
    read?.modifiedArgs.command,
    /^'[^']*node[^']*' '[^']*with-gh-token\.mjs' '[A-Za-z0-9+/=]+'$/,
  );
  assert.equal(rewrittenPayload(read?.modifiedArgs.command).repo, "demo-repo");
});

test("a trailing command after a launcher line is denied", async () => {
  assertDenied(
    await answer(
      "powershell",
      `${wrappedPs(plainJson("gh pr view 1"))}; git push upstream main`,
      "read",
    ),
    WRAPPED_DENIAL,
  );
  assertDenied(
    await answer(
      "bash",
      `${wrappedBash(plainJson("gh pr view 1"))} && git push upstream main`,
      "read",
    ),
    WRAPPED_DENIAL,
  );
});

test("an undecodable base64 argument is denied with the wrapped message", async () => {
  assertDenied(
    await answer(
      "powershell",
      `& '${NODE}' '${LAUNCHER}' '${b64("not json")}'`,
      "read",
    ),
    WRAPPED_DENIAL,
  );
  assertDenied(
    await answer(
      "powershell",
      `& '${NODE}' '${LAUNCHER}' 'not base64!'`,
      "read",
    ),
    WRAPPED_DENIAL,
  );
});

test("a payload with a non-string, empty, or missing command is denied with the wrapped message", async () => {
  for (const json of [
    '{"command":5}',
    '{"command":""}',
    '{"workspace":"D:\\\\dev\\\\simpsonm09","repo":"demo-repo"}',
    "[]",
  ]) {
    assertDenied(
      await answer("powershell", wrappedPs(json), "read"),
      WRAPPED_DENIAL,
    );
  }
});

test("a plain command in a payload that itself runs the launcher is denied, not decided again", async () => {
  assertDenied(
    await answer(
      "powershell",
      wrappedPs(plainJson(wrappedPs(plainJson("gh pr view 1")))),
      "read",
    ),
    WRAPPED_DENIAL,
  );
});

test("a PowerShell launcher line sent as the Bash tool is denied with the wrapped message", async () => {
  assertDenied(
    await answer("bash", wrappedPs(plainJson("gh pr view 1")), "read"),
    WRAPPED_DENIAL,
  );
});

test("the shape check reads the base64 argument, and the paths are never used", () => {
  const base64 = b64(plainJson("gh pr view 1"));
  assert.equal(
    launcherLinePayload(wrappedPs(plainJson("gh pr view 1")), "powershell"),
    base64,
  );
  assert.equal(
    launcherLinePayload(`& 'a' 'b' '${base64}' extra`, "powershell"),
    null,
  );
  assert.equal(launcherLinePayload(`'a' 'b' '${base64}'`, "powershell"), null);
});

test("the Claude path still denies any launcher line with its own message", async () => {
  writeCatalog(ws, "read");
  const out = await claudePreToolUse(
    {
      tool_name: "PowerShell",
      cwd: demo,
      tool_input: { command: wrappedPs(plainJson("gh pr view 1")) },
    },
    { workspaceRoot: ws, env: TOKEN_ENV },
  );
  assert.equal(out?.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(
    out?.hookSpecificOutput.permissionDecisionReason,
    LAUNCHER_DENIAL,
  );
});

test("the session note tells the model to type plain commands and never to write the launcher line", () => {
  assert.match(
    SESSION_NOTE,
    /rewritten to run through a GitHub token launcher/,
  );
  assert.match(SESSION_NOTE, /never write the launcher line yourself/);
});
