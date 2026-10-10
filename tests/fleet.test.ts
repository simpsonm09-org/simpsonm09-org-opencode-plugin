// Which fleet repository a directory belongs to. A clone names itself; a worktree is named
// through its git common dir; a directory outside the fleet, or a git that cannot run, is
// not answered as a fleet repository (the second is a throw, so the caller fails closed).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { repoFromCommonDir } from "../gate.mjs";
import { fleetLookup, fleetRepoFor, gitCommonDir } from "../lib/fleet.mjs";
import {
  buildWorkspace,
  removeDir,
  tempDir,
} from "./support/fixture-workspace.mjs";

let ws = "";

before(() => {
  ws = tempDir("fleet-");
  buildWorkspace(ws, { level: "read" });
  // A repository that is not a fleet clone, and a worktree of it.
  const solo = join(ws, "projects", "other", "solo");
  mkdirSync(solo, { recursive: true });
  execFileSync("git", ["-C", solo, "init", "--quiet", "-b", "main"], {
    windowsHide: true,
  });
  execFileSync(
    "git",
    [
      "-C",
      solo,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--no-verify",
      "--allow-empty",
      "-m",
      "init",
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "f",
        GIT_AUTHOR_EMAIL: "f@e.invalid",
        GIT_COMMITTER_NAME: "f",
        GIT_COMMITTER_EMAIL: "f@e.invalid",
      },
    },
  );
  execFileSync(
    "git",
    [
      "-C",
      solo,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "wt-solo",
      join(ws, "projects", "worktrees", "wt-solo"),
    ],
    { windowsHide: true },
  );
});

after(() => {
  if (ws) removeDir(ws);
});

test("a clone names itself, and a folder inside it names the clone", () => {
  assert.equal(
    fleetRepoFor(join(ws, "projects", "repos", "demo-repo"), ws),
    "demo-repo",
  );
  assert.equal(
    fleetRepoFor(join(ws, "projects", "repos", "demo-repo", "src", "deep"), ws),
    "demo-repo",
  );
});

test("a directory outside the fleet is not a fleet repository", () => {
  assert.equal(fleetRepoFor(join(ws, "projects", "other", "x"), ws), null);
  assert.equal(fleetRepoFor(join(ws, "elsewhere"), ws), null);
  assert.equal(fleetRepoFor(undefined, ws), null);
  assert.equal(fleetRepoFor(42 as unknown as string, ws), null);
});

test("a worktree of a fleet clone resolves to that clone through git's common dir", () => {
  mkdirSync(join(ws, "projects", "worktrees", "wt-demo", "src"), {
    recursive: true,
  });
  assert.equal(
    fleetRepoFor(join(ws, "projects", "worktrees", "wt-demo"), ws),
    "demo-repo",
  );
  assert.equal(
    fleetRepoFor(join(ws, "projects", "worktrees", "wt-demo", "src"), ws),
    "demo-repo",
  );
});

test("a worktree of a repository outside the fleet is not a fleet repository", () => {
  assert.equal(
    fleetRepoFor(join(ws, "projects", "worktrees", "wt-solo"), ws),
    null,
  );
});

test("a directory under repos that is not a git clone resolves by its name", () => {
  // The clone is named by its path; git is not consulted for a clone directory.
  assert.equal(
    fleetRepoFor(join(ws, "projects", "repos", "nogit-repo"), ws),
    "nogit-repo",
  );
});

test("a worktree whose git cannot answer throws, so the caller fails closed", () => {
  assert.throws(
    () =>
      fleetRepoFor(join(ws, "projects", "worktrees", "wt-demo"), ws, () => {
        throw new Error("git is missing");
      }),
    /git is missing/,
  );
});

test("gitCommonDir names the clone's .git for a worktree and null for a non-repository", () => {
  const common = gitCommonDir(join(ws, "projects", "worktrees", "wt-demo"));
  assert.ok(common?.endsWith(".git"), `common dir was ${common}`);
  assert.equal(gitCommonDir(join(ws, "projects", "repos", "nogit-repo")), null);
});

test("a junction from outside the workspace into a clone still names the clone", (t) => {
  const link = join(tempDir("fleet-link-"), "link");
  try {
    symlinkSync(join(ws, "projects", "repos", "demo-repo"), link, "junction");
  } catch {
    return t.skip("cannot create a junction here");
  }
  assert.equal(fleetRepoFor(link, ws), "demo-repo");
});

test("a path that differs from the clone's path only by letter case names the clone, where the file system ignores case", (t) => {
  if (!existsSync(join(ws, "projects", "REPOS"))) {
    return t.skip("the file system is case-sensitive");
  }
  assert.equal(
    fleetRepoFor(join(ws, "projects", "REPOS", "DEMO-REPO"), ws),
    "demo-repo",
  );
});

test("repoFromCommonDir names only a clone directly under repos", () => {
  const root = resolve("ws-root");
  assert.equal(
    repoFromCommonDir(join(root, "projects", "repos", "x", ".git"), root),
    "x",
  );
  assert.equal(
    repoFromCommonDir(
      join(root, "projects", "repos", "x", "sub", ".git"),
      root,
    ),
    null,
  );
  assert.equal(
    repoFromCommonDir(join(root, "projects", "x", ".git"), root),
    null,
  );
  assert.equal(
    repoFromCommonDir(join(root, "projects", "repos", ".git"), root),
    null,
  );
  assert.equal(repoFromCommonDir("relative/.git", root), null);
  assert.equal(
    repoFromCommonDir(join(root, "projects", "repos", "x", "objects"), root),
    null,
  );
});

test("fleetLookup reports a directory it cannot resolve as unresolved, and never throws", () => {
  const failing = () => {
    throw new Error("git is missing");
  };
  assert.deepEqual(
    fleetLookup(join(ws, "projects", "worktrees", "wt-demo"), ws, failing),
    { repo: null, unresolved: true },
  );
  assert.deepEqual(
    fleetLookup(join(ws, "projects", "repos", "demo-repo"), ws, failing),
    { repo: "demo-repo" },
  );
  assert.deepEqual(
    fleetLookup(join(ws, "projects", "other", "x"), ws, failing),
    { repo: null },
  );
});
