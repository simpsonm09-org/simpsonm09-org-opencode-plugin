// The shared decision (gate.mjs decideShell and gateShellEdit) with the resolver's answer
// injected, and the adapter-side access functions (access.mjs) that feed it. These are the
// rules both harnesses use, so each is asserted directly, not only through a harness.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { levelFor, resolveAccess, tokenFor } from "../access.mjs";
import {
  decideShell,
  denyCommand,
  denyMessage,
  fileName,
  gateShellEdit,
  isPowerShell,
  isWorktreePath,
  shouldInject,
} from "../gate.mjs";
import { removeDir, tempDir } from "./support/fixture-workspace.mjs";

const ws = resolve("ws-root");
const cwd = join(ws, "projects", "repos", "demo-repo");
const ok = { code: 0, stdout: JSON.stringify({ level: "propose" }) };
const deny = { code: 1, stdout: JSON.stringify({ level: "read" }) };
const unknown = { code: 2, stdout: "" };

function deps(
  result: { code: number; stdout: string },
  extra: Record<string, unknown> = {},
) {
  const calls: Array<{
    repo: string;
    command: string;
    remoteUrl: string | null;
  }> = [];
  return {
    calls,
    deps: {
      cwd,
      workspaceRoot: ws,
      resolve: (repo: string, command: string, remoteUrl: string | null) => {
        calls.push({ repo, command, remoteUrl });
        return result;
      },
      remoteUrl: () => null,
      ...extra,
    },
  };
}

test("a directory outside the fleet passes without asking the resolver", () => {
  const spy = deps(deny);
  const decision = decideShell(
    { command: "git push origin main" },
    { ...spy.deps, cwd: join(ws, "elsewhere") },
  );
  assert.equal(decision.action, "pass");
  assert.equal(decision.repo, null);
  assert.equal(spy.calls.length, 0);
});

test("a resolver denial is a deny with the level it resolved", () => {
  const decision = decideShell({ command: "gh pr merge 1" }, deps(deny).deps);
  assert.deepEqual(decision, {
    action: "deny",
    repo: "demo-repo",
    level: "read",
    reason: 'demo-repo denies this command at level "read"',
  });
});

test("a resolver that cannot answer denies a write and passes a read", () => {
  assert.equal(
    decideShell({ command: "git push origin main" }, deps(unknown).deps).action,
    "deny",
  );
  assert.equal(
    decideShell({ command: "git status" }, deps(unknown).deps).action,
    "pass",
  );
});

test("an allowed gh call is an inject, and an allowed non-gh call is a pass", () => {
  assert.equal(
    decideShell({ command: "gh pr view 1" }, deps(ok).deps).action,
    "inject",
  );
  assert.equal(
    decideShell({ command: "npm test" }, deps(ok).deps).action,
    "pass",
  );
});

test("the shared decision reads an executable spelling of gh and git as the plain name", () => {
  assert.equal(
    decideShell(
      { command: '"C:\\Program Files\\GitHub CLI\\gh.exe" pr view 1' },
      deps(ok).deps,
    ).action,
    "inject",
  );
  const spy = deps(ok);
  decideShell({ command: "GIT.exe push origin main" }, spy.deps);
  assert.deepEqual(
    spy.calls.map((call) => call.command),
    ["git push origin main"],
    "the resolver is asked about the plain name",
  );
});

test("a leading space keeps a gh call out of the injection, as HEAD did", () => {
  assert.equal(shouldInject(" gh pr view 1"), false);
  assert.equal(
    decideShell({ command: " gh pr view 1" }, deps(ok).deps).action,
    "pass",
  );
});

test("the remote URL is looked up for a push and only for a push", () => {
  const seen: string[] = [];
  const spy = deps(ok, {
    remoteUrl: (remote: string) => {
      seen.push(remote);
      return "https://github.com/simpsonm09/fork.git";
    },
  });
  decideShell({ command: "git push origin main" }, spy.deps);
  decideShell({ command: "git status" }, spy.deps);
  assert.deepEqual(seen, ["origin"]);
  assert.equal(
    spy.calls[0].remoteUrl,
    "https://github.com/simpsonm09/fork.git",
  );
});

test("a directory the lookup cannot resolve is a denied write and a passed read, with no resolver call", () => {
  const spy = deps(ok);
  const write = decideShell(
    { command: "git push origin main" },
    { ...spy.deps, lookup: () => ({ repo: null, unresolved: true }) },
  );
  assert.equal(write.action, "deny");
  assert.match(
    write.reason ?? "",
    /could not be resolved to a fleet repository for this write/,
  );
  const read = decideShell(
    { command: "git status" },
    { ...spy.deps, lookup: () => ({ repo: null, unresolved: true }) },
  );
  assert.equal(read.action, "pass");
  assert.equal(spy.calls.length, 0);
});

test("a gh call from a directory the lookup cannot resolve is a denied write", () => {
  const decision = decideShell(
    { command: "gh pr view 1" },
    { ...deps(ok).deps, lookup: () => ({ repo: null, unresolved: true }) },
  );
  assert.equal(decision.action, "deny");
});

test("PowerShell is recognized from a Windows-style path on any platform", () => {
  assert.equal(
    isPowerShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
    true,
  );
  assert.equal(isPowerShell("/opt/microsoft/powershell/7/pwsh"), true);
  assert.equal(
    isPowerShell(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ),
    true,
  );
  assert.equal(isPowerShell("/bin/bash"), false);
  assert.equal(fileName("C:\\a\\b.exe"), "b.exe");
});

test("the injected repository lookup decides which repository a directory is", () => {
  const spy = deps(deny);
  const decision = decideShell(
    { command: "gh pr merge 1" },
    { ...spy.deps, cwd: "anywhere", lookup: () => ({ repo: "other-repo" }) },
  );
  assert.equal(decision.repo, "other-repo");
  assert.equal(spy.calls[0].repo, "other-repo");
});

test("gateShellEdit rewrites a denial and leaves the environment alone", async () => {
  const input: { command: string; shell?: string } = {
    command: "gh pr merge 1",
  };
  const env: Record<string, string> = {};
  await gateShellEdit(input, env, {
    ...deps(deny).deps,
    tokenFor: async () => "never",
  });
  assert.equal(
    input.command,
    denyCommand('demo-repo denies this command at level "read"'),
  );
  assert.deepEqual(env, {});
});

test("gateShellEdit denies an allowed gh call when no token can be minted", async () => {
  const input: { command: string; shell?: string } = {
    command: "gh pr view 1",
  };
  const env: Record<string, string> = {};
  const decision = await gateShellEdit(input, env, {
    ...deps(ok).deps,
    tokenFor: async () => null,
  });
  assert.equal(decision.action, "deny");
  assert.equal(
    input.command,
    denyCommand("demo-repo could not mint a token for a gh command"),
  );
  assert.equal(env.GH_TOKEN, undefined);
});

test("gateShellEdit sets GH_TOKEN for an allowed gh call", async () => {
  const input: { command: string } = { command: "gh pr view 1" };
  const env: Record<string, string> = {};
  const decision = await gateShellEdit(input, env, {
    ...deps(ok).deps,
    tokenFor: async () => "fixture-token",
  });
  assert.equal(decision.action, "inject");
  assert.equal(input.command, "gh pr view 1");
  assert.equal(env.GH_TOKEN, "fixture-token");
});

test("denyMessage is the reason line both harnesses print", () => {
  assert.equal(denyMessage("x"), "agent-access: denied: x");
});

test("isWorktreePath recognizes a folder under projects/worktrees only", () => {
  assert.equal(
    isWorktreePath(join(ws, "projects", "worktrees", "w"), ws),
    true,
  );
  assert.equal(isWorktreePath(join(ws, "projects", "worktrees"), ws), false);
  assert.equal(isWorktreePath(join(ws, "projects", "repos", "w"), ws), false);
});

test("the access adapter keeps one token per repository", async () => {
  const minted: string[] = [];
  const api = {
    mintForRepo: async (_owner: string, repo: string) => {
      minted.push(repo);
      return { token: `token-for-${repo}`, expires_at: "2099-01-01T00:00:00Z" };
    },
  };
  assert.equal(await tokenFor(api, "", "alpha-repo"), "token-for-alpha-repo");
  assert.equal(
    await tokenFor(api, "", "beta-repo"),
    "token-for-beta-repo",
    "a repo never gets another repo's token",
  );
  assert.equal(await tokenFor(api, "", "alpha-repo"), "token-for-alpha-repo");
  assert.deepEqual(
    minted,
    ["alpha-repo", "beta-repo"],
    "a cached token is reused, not minted again",
  );
});

test("a broker that fails or returns no token yields no token", async () => {
  const failing = { mintForRepo: async () => Promise.reject(new Error("401")) };
  const empty = { mintForRepo: async () => ({ token: "", expires_at: "" }) };
  assert.equal(await tokenFor(failing, "", "gamma-repo"), null);
  assert.equal(await tokenFor(empty, "", "delta-repo"), null);
});

test("a broker script that only ships a CLI mints its token in a Node child process", async () => {
  const dir = tempDir("broker-cli-");
  try {
    const script = join(dir, "agent-token.mjs");
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({ token: "cli-token", expires_at: "2099-01-01T00:00:00Z" }));\n',
    );
    assert.equal(await tokenFor(null, script, "cli-repo"), "cli-token");
  } finally {
    removeDir(dir);
  }
});

test("a resolver module that throws is an unknown answer, not a crash", () => {
  const api = {
    loadCatalog: () => {
      throw new Error("no catalog");
    },
    resolveLevel: () => ({}),
    decide: () => ({ capability: null, allowed: true }),
  };
  assert.deepEqual(
    resolveAccess(api, "unused", "demo-repo", "git push origin main", null),
    { code: 2, stdout: "" },
  );
});

test("a missing resolver script is an unknown answer, and the level falls back to read", () => {
  assert.deepEqual(
    resolveAccess(null, join(ws, "missing.mjs"), "demo-repo", "git push", null),
    { code: 2, stdout: "" },
  );
  assert.equal(levelFor(null, "demo-repo"), "read");
});
