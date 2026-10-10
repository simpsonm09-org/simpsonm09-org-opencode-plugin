// A throwaway workspace for the gate tests. It has the layout the plugin trusts
// (projects/repos, projects/worktrees), the frozen copy of the installed resolver where the
// plugin expects it, a catalog that sets one level, real local git clones with the remotes
// the cells use, and a real worktree. Nothing here reaches the network: remotes are only
// names in .git/config, and the token broker is a literal stub.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The frozen copy of scripts/agent-access.mjs from the installed repo-standard clone.
export const FROZEN_RESOLVER = resolve(
  here,
  "..",
  "fixtures",
  "installed-agent-access.mjs",
);

// The token the stub broker mints. A literal, never a credential.
export const FIXTURE_TOKEN = "fixture-token-not-real";

export const ORG_URL = "https://github.com/simpsonm09-org/demo-repo.git";
export const FORK_URL = "https://github.com/simpsonm09/fork-repo.git";

// The git clones the cells use. nogit-repo is a directory with no git; unlisted-repo is a
// clone the catalog does not name, so the resolver falls back to its default level.
export const CLONES = [
  { name: "demo-repo", origin: ORG_URL },
  { name: "fork-repo", origin: FORK_URL },
  {
    name: "unlisted-repo",
    origin: "https://github.com/simpsonm09-org/unlisted-repo.git",
  },
];

/**
 * Write the catalog the frozen resolver reads: demo-repo and fork-repo at the given level.
 * @param {string} workspace
 * @param {string} level
 */
export function writeCatalog(workspace, level) {
  const dir = join(workspace, "projects", "repos", "simpsonm09-repo-catalog");
  mkdirSync(dir, { recursive: true });
  const catalog = {
    agentAccessDefaults: { standard: "read" },
    repos: [
      { name: "demo-repo", tier: "standard", agentAccess: level },
      { name: "fork-repo", tier: "standard", agentAccess: level },
    ],
  };
  writeFileSync(
    join(dir, "repos.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const identity = {
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    windowsHide: true,
    cwd,
    env: { ...process.env, ...identity },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Build the workspace in dir (created if absent) and return its layout.
 * @param {string} dir
 * @param {{ level?: string }} [options]
 * @returns {{ workspace: string, cwd: (relative: string) => string }}
 */
export function buildWorkspace(dir, { level = "read" } = {}) {
  const workspace = resolve(dir);
  const standard = join(
    workspace,
    "projects",
    "repos",
    "simpsonm09-repo-standard",
    "scripts",
  );
  mkdirSync(standard, { recursive: true });
  copyFileSync(FROZEN_RESOLVER, join(standard, "agent-access.mjs"));
  writeFileSync(
    join(standard, "agent-token.mjs"),
    `export async function mintForRepo() {\n  return { token: ${JSON.stringify(FIXTURE_TOKEN)}, expires_at: "2099-01-01T00:00:00Z" };\n}\n`,
  );
  writeCatalog(workspace, level);

  for (const clone of CLONES) {
    const path = join(workspace, "projects", "repos", clone.name);
    mkdirSync(path, { recursive: true });
    git(path, ["init", "--quiet", "-b", "main"]);
    git(path, [
      "commit",
      "--quiet",
      "--no-verify",
      "--allow-empty",
      "-m",
      "init",
    ]);
    git(path, ["remote", "add", "origin", clone.origin]);
  }
  // A directory under repos that is not a git clone.
  mkdirSync(join(workspace, "projects", "repos", "nogit-repo"), {
    recursive: true,
  });
  // A worktree of demo-repo. Its common dir is demo-repo/.git.
  const worktree = join(workspace, "projects", "worktrees", "wt-demo");
  mkdirSync(join(workspace, "projects", "worktrees"), { recursive: true });
  git(join(workspace, "projects", "repos", "demo-repo"), [
    "worktree",
    "add",
    "--quiet",
    "-b",
    "wt-demo",
    worktree,
  ]);
  // A directory outside every fleet clone, and a nested folder inside demo-repo.
  mkdirSync(join(workspace, "projects", "other", "x"), { recursive: true });
  // A junction from outside projects/repos into demo-repo. A junction on Windows, a symlink
  // elsewhere; both resolve to the clone's real path.
  symlinkSync(
    join(workspace, "projects", "repos", "demo-repo"),
    join(workspace, "projects", "other", "link-demo"),
    "junction",
  );
  mkdirSync(join(workspace, "projects", "repos", "demo-repo", "src", "deep"), {
    recursive: true,
  });

  return {
    workspace,
    cwd: (relative) => join(workspace, ...relative.split("/")),
  };
}

/**
 * A temp directory for one test, with the workspace built in it. The caller removes it.
 * @param {string} [prefix]
 * @returns {string}
 */
export function tempDir(prefix = "gate-fixture-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @param {string} dir
 */
export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
