import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import plugin from "../index.ts";

// index.ts takes its workspace from options.workspaceRoot (a test seam; in production the
// workspace is three levels above the plugin) and its resolver and broker from
// options.scripts. Every test here sets both to a temporary workspace and fixture scripts,
// so the setup wiring runs in any checkout and never touches a real clone.

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(here, "..");

// Every test runs under a temporary workspace root that this file creates and removes. The
// real workspace, its clones, and its sibling scripts are never read or written.
let workspaceRoot = "";
let reposRoot = "";
let fleetCwd = "";

before(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "org-index-ws-"));
  reposRoot = join(workspaceRoot, "projects", "repos");
  mkdirSync(reposRoot, { recursive: true });
  fleetCwd = join(reposRoot, "demo-repo");
});

after(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

// The cwd must resolve to a fleet clone, but the clone directory does not have
// to exist for repoFromCwd, so a path under projects/repos works without a
// workspace. The script paths come from the fixture, never the environment.

// A resolver module that reports a fixed level and allows commands whose
// capability is in the allowed set. It mirrors the real scripts/agent-access.mjs
// interface, including the optional remoteUrl on decide, so the plugin calls it
// in-process. A git push to a known non-organization URL is out of scope and
// allowed; every other decision defers to the allowed set. The token is a
// literal, never a real credential.
function accessModuleSource({ level = "propose", allows = ["read"] } = {}) {
  return `export function loadCatalog() {
  return { repos: [{ name: "demo-repo", tier: "plugin" }] };
}
export function loadCommittedCatalog() {
  return null;
}
export function resolveLevel(catalog, repoName) {
  return { repo: repoName, tier: "plugin", level: ${JSON.stringify(level)}, source: "tier" };
}
export function decide(level, command, remoteUrl) {
  const url = remoteUrl ?? "";
  const isPush = /(^|\\s)git push(\\s|$)/.test(command);
  if (isPush && url.length > 0 && !url.includes("simpsonm09-org")) {
    return { capability: null, allowed: true };
  }
  let capability = "read";
  if (command.startsWith("gh pr merge")) capability = "mergePr";
  else if (isPush && /\\bmain\\b/.test(command)) capability = "pushMain";
  else if (isPush) capability = "pushBranch";
  return { capability, allowed: ${JSON.stringify(allows)}.includes(capability) };
}
`;
}

function tokenModuleSource(token = "fixture-token-not-real") {
  return `export async function mintForRepo(owner, repo) {
  return { token: ${JSON.stringify(token)}, expires_at: "2099-01-01T00:00:00Z" };
}
`;
}

// A resolver that ships only a CLI, no module exports. It exercises the spawn
// fallback, which must run it with a Node runtime. Like the real resolver, it
// guards its CLI entry so importing it as a module has no side effect.
const CLI_ACCESS_SCRIPT = `#!/usr/bin/env node
import { pathToFileURL } from "node:url";
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--command")) {
    process.stdout.write(JSON.stringify({ level: "propose", capability: "read", allowed: true }));
  } else {
    process.stdout.write(JSON.stringify({ level: "propose" }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
`;

function fixtureScripts({ access, token } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "org-scripts-"));
  const accessPath = join(dir, "agent-access.mjs");
  const tokenPath = join(dir, "agent-token.mjs");
  writeFileSync(accessPath, access ?? accessModuleSource());
  writeFileSync(tokenPath, token ?? tokenModuleSource());
  return { dir, access: accessPath, token: tokenPath };
}

// Scripts that do not exist: a test that does not pass its own scripts gets an unknown resolver,
// never the sibling clone's.
function absentScripts() {
  return {
    access: join(workspaceRoot, "absent-agent-access.mjs"),
    token: join(workspaceRoot, "absent-agent-token.mjs"),
  };
}

async function setupWithStubs({ location, scripts } = {}) {
  const skills = [];
  const editor = {
    get: (id) => skills.find((skill) => skill.id === id),
    remove: (id) => {
      const index = skills.findIndex((skill) => skill.id === id);
      if (index >= 0) skills.splice(index, 1);
    },
    add: (skill) => skills.push(skill),
  };
  const shellCallbacks = new Map();
  const sessionCallbacks = new Map();
  const shell = {
    hook: async (name, callback) => {
      shellCallbacks.set(name, callback);
      return { dispose: async () => {} };
    },
  };
  const session = {
    hook: async (name, callback) => {
      sessionCallbacks.set(name, callback);
      return { dispose: async () => {} };
    },
  };
  const skill = {
    transform: async (callback) => {
      callback(editor);
      return { dispose: async () => {} };
    },
  };

  await plugin.setup({
    skill,
    shell,
    session,
    location: { directory: resolve(location ?? repoDir) },
    options: { workspaceRoot, scripts: scripts ?? absentScripts() },
  });

  return {
    skills,
    shellBefore: shellCallbacks.get("create.before"),
    sessionContext: sessionCallbacks.get("context"),
  };
}

async function withFixture(body, options) {
  const scripts = fixtureScripts(options);
  try {
    await body(scripts);
  } finally {
    rmSync(scripts.dir, { recursive: true, force: true });
  }
}

test("setup registers every repository skill through the transform editor", async () => {
  const { skills } = await setupWithStubs();

  const ids = skills.map((skill) => skill.id).sort();
  assert.ok(ids.includes("service-integrations"), `skills ${ids}`);
  assert.ok(ids.includes("repo-standard"), `skills ${ids}`);
  assert.ok(ids.includes("repo-tasks"), `skills ${ids}`);
  assert.ok(ids.includes("local-services"), `skills ${ids}`);
  for (const skill of skills) {
    assert.equal(typeof skill.name, "string");
    assert.equal(typeof skill.description, "string");
    assert.ok(skill.description.length > 0, `${skill.id} has no description`);
  }
});

test("the shell create.before hook leaves a cwd outside the fleet alone", async () => {
  const { shellBefore } = await setupWithStubs();
  assert.equal(typeof shellBefore, "function");

  const input = { command: "ls -la", cwd: workspaceRoot, env: {} };
  const result = await shellBefore(input);

  assert.equal(result, undefined);
  assert.equal(input.command, "ls -la");
  assert.deepEqual(input.env, {});
});

test("setup leaves the resolver unknown when the scripts are absent", async () => {
  const missing = join(tmpdir(), "org-scripts-absent-xyz");
  const { shellBefore, sessionContext } = await setupWithStubs({
    location: fleetCwd,
    scripts: {
      access: join(missing, "agent-access.mjs"),
      token: join(missing, "agent-token.mjs"),
    },
  });

  // A gh command is a write, so an unknown resolver fails closed.
  const ghInput = { command: "gh pr merge 3", cwd: fleetCwd, env: {} };
  await shellBefore(ghInput);
  assert.match(ghInput.command, />&2/);
  assert.match(ghInput.command, /exit 1/);
  assert.equal(ghInput.env.GH_TOKEN, undefined);

  // A read passes untouched, and the level falls back to read.
  const readInput = { command: "ls -la", cwd: fleetCwd, env: {} };
  await shellBefore(readInput);
  assert.equal(readInput.command, "ls -la");

  const event = { system: [] };
  sessionContext(event);
  assert.equal(event.system.length, 1);
  assert.match(event.system[0].text, /"read"/);
});

test("the shell create.before hook fails closed when the broker cannot mint", async () => {
  await withFixture(async (scripts) => {
    const { shellBefore } = await setupWithStubs({
      location: fleetCwd,
      scripts: {
        access: scripts.access,
        token: join(scripts.dir, "absent.mjs"),
      },
    });

    const input = { command: "gh pr create --fill", cwd: fleetCwd, env: {} };
    await shellBefore(input);

    assert.match(input.command, />&2/);
    assert.match(input.command, /exit 1/);
    assert.equal(input.env.GH_TOKEN, undefined);
  });
});

test("the hook reports the module's real level, not the fallback, on a denial", async () => {
  await withFixture(async (scripts) => {
    const { shellBefore } = await setupWithStubs({
      location: fleetCwd,
      scripts,
    });

    // mergePr is denied at level "propose", so the level in the message must be
    // "propose", never the "read" fallback the live spawn bug produced.
    const input = { command: "gh pr merge 3", cwd: fleetCwd, env: {} };
    await shellBefore(input);

    assert.match(input.command, /denies this command at level "propose"/);
    assert.doesNotMatch(input.command, /level "read"/);
  });
});

test("the hook emits a PowerShell denial for a pwsh shell", async () => {
  await withFixture(async (scripts) => {
    const { shellBefore } = await setupWithStubs({
      location: fleetCwd,
      scripts,
    });

    const input = {
      command: "gh pr merge 3",
      cwd: fleetCwd,
      env: {},
      shell: "C:/Program Files/WindowsApps/PowerShell/pwsh.EXE",
    };
    await shellBefore(input);

    assert.match(input.command, /^Write-Error '/);
    assert.match(input.command, /; exit 1$/);
    assert.doesNotMatch(input.command, />&2/);
  });
});

test("the hook resolves a command through a module that has no CLI shim", async () => {
  await withFixture(
    async (scripts) => {
      const { shellBefore } = await setupWithStubs({
        location: fleetCwd,
        scripts,
      });

      const input = { command: "gh pr list", cwd: fleetCwd, env: {} };
      await shellBefore(input);

      assert.equal(input.command, "gh pr list");
      assert.equal(input.env.GH_TOKEN, "fixture-token-not-real");
    },
    { access: CLI_ACCESS_SCRIPT },
  );
});

test("the shell create.before hook injects a token for an allowed gh command", async () => {
  await withFixture(async (scripts) => {
    const { shellBefore } = await setupWithStubs({
      location: fleetCwd,
      scripts,
    });

    const input = { command: "gh pr list", cwd: fleetCwd, env: {} };
    await shellBefore(input);

    assert.equal(input.command, "gh pr list");
    assert.equal(typeof input.env.GH_TOKEN, "string");
    assert.equal(input.env.GH_TOKEN, "fixture-token-not-real");
  });
});

test("the context callback appends the resolved level for a fleet clone", async () => {
  await withFixture(async (scripts) => {
    const { sessionContext } = await setupWithStubs({
      location: fleetCwd,
      scripts,
    });

    const event = { system: [] };
    sessionContext(event);

    assert.equal(event.system.length, 1);
    assert.equal(event.system[0].type, "text");
    assert.match(
      event.system[0].text,
      /agent-access: the repository demo-repo /,
    );
    assert.match(event.system[0].text, /"propose"/);
  });
});

test("the context callback leaves a cwd outside the fleet alone", async () => {
  const { sessionContext } = await setupWithStubs({ location: workspaceRoot });
  const event = { system: [] };
  sessionContext(event);
  assert.deepEqual(event.system, []);
});

// A real git clone under projects/repos, so the plugin's git remote lookup runs
// for real. The remotes point at the fork and the organization, matching the
// workspace. Returns the directory and a teardown.
function realFleetClone(name: string, remotes: Record<string, string>) {
  const dir = join(reposRoot, name);
  rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["init", "-q", dir], { windowsHide: true });
  for (const [remote, url] of Object.entries(remotes)) {
    execFileSync("git", ["-C", dir, "remote", "add", remote, url], {
      windowsHide: true,
    });
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a fork push is allowed through the live plugin wiring at a propose repo", async () => {
  const clone = realFleetClone("u8-fork-probe", {
    origin: "https://github.com/simpsonm09/simpsonm09-repo-standard.git",
    upstream: "https://github.com/simpsonm09-org/simpsonm09-repo-standard.git",
  });
  try {
    await withFixture(async (scripts) => {
      const { shellBefore } = await setupWithStubs({
        location: clone.dir,
        scripts,
      });

      const input = {
        command: "git push --dry-run origin main",
        cwd: clone.dir,
        env: {},
      };
      await shellBefore(input);

      assert.equal(input.command, "git push --dry-run origin main");
      assert.doesNotMatch(input.command, /exit 1/);
    });
  } finally {
    clone.cleanup();
  }
});

test("an organization main push is denied through the live plugin wiring at a propose repo", async () => {
  const clone = realFleetClone("u8-org-probe", {
    origin: "https://github.com/simpsonm09/simpsonm09-repo-standard.git",
    upstream: "https://github.com/simpsonm09-org/simpsonm09-repo-standard.git",
  });
  try {
    await withFixture(async (scripts) => {
      const { shellBefore } = await setupWithStubs({
        location: clone.dir,
        scripts,
      });

      const input = {
        command: "git push --dry-run upstream main",
        cwd: clone.dir,
        env: {},
      };
      await shellBefore(input);

      assert.match(input.command, /agent-access: denied/);
      assert.match(input.command, /exit 1/);
    });
  } finally {
    clone.cleanup();
  }
});

// A worktree directory is resolved through git. With git missing from PATH, the lookup cannot
// run, and the gate must answer the way it answers a command the resolver cannot decide: a
// write is denied, a read passes, and no context line is added. It must not throw.
test("with git missing from PATH, a write in a worktree is denied, a read passes, and no context line is added", async () => {
  const worktree = join(workspaceRoot, "projects", "worktrees", "wt-no-git");
  mkdirSync(worktree, { recursive: true });
  const emptyPath = mkdtempSync(join(tmpdir(), "org-empty-path-"));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyPath;
  try {
    const { shellBefore, sessionContext } = await setupWithStubs({
      location: worktree,
    });

    const write = { command: "git push origin main", cwd: worktree, env: {} };
    await shellBefore(write);
    assert.match(
      write.command,
      /agent-access: denied: the working directory could not be resolved/,
    );
    assert.match(write.command, /exit 1/);

    const read = { command: "git status", cwd: worktree, env: {} };
    await shellBefore(read);
    assert.equal(read.command, "git status");

    const event = { system: [] as unknown[] };
    sessionContext(event);
    assert.deepEqual(event.system, []);
  } finally {
    process.env.PATH = savedPath;
    rmSync(emptyPath, { recursive: true, force: true });
  }
});
