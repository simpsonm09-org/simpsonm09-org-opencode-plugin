// Find the fleet repository a working directory belongs to. Both harnesses use it, so a
// command is gated the same way in OpenCode and in Claude Code. A fleet clone sits at
// <workspace>/projects/repos/<repo>, and a worktree sits at
// <workspace>/projects/worktrees/<name>. A worktree is not named after its repository, so
// it resolves to the real repository through git's common dir.
//
// The directory is resolved to its real path first, so a junction into a fleet clone
// resolves to that clone. The lexical path is tried after it, so a junction from inside
// the workspace out to elsewhere still resolves to the clone the path names, as before.
// The workspace is an explicit argument, never the environment: the caller decides which
// workspace it trusts (lib/location.mjs). A git lookup that cannot run (missing binary,
// timeout) throws, so the caller fails closed; a directory git reports as not a
// repository resolves to null.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isWorktreePath, repoFromCommonDir, repoFromCwd } from "../gate.mjs";
import { timeoutFor } from "./budget.mjs";
import { realPath } from "./location.mjs";

const GIT_TIMEOUT_MS = 5_000;

// The git common dir of a worktree is the clone's .git directory. A directory git reports
// as not a repository yields null. A git that cannot run, or does not answer in time,
// throws.
/**
 * @param {string} cwd
 * @returns {string | null}
 */
export function gitCommonDir(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutFor(GIT_TIMEOUT_MS),
      },
    );
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    if (typeof (/** @type {any} */ (error)?.status) === "number") return null;
    throw error;
  }
}

// The repository one path names: a clone directly, or a worktree through its common dir.
// The clone's real path is compared against the real workspace root, since git reports
// the common dir in its own form. Null for anything else.
/**
 * @param {string} dir
 * @param {string} root the workspace root, in the same form as dir
 * @param {string} realRoot the workspace root as a real path
 * @param {(cwd: string) => string | null} commonDir
 * @returns {string | null}
 */
function repoNamedBy(dir, root, realRoot, commonDir) {
  const direct = repoFromCwd(dir, root);
  if (direct) return direct;
  if (!isWorktreePath(dir, root)) return null;
  const common = commonDir(dir);
  return repoFromCommonDir(common ? realPath(common) : null, realRoot);
}

// Resolve a directory to the fleet repository it belongs to under the workspace, or null
// when it is not a fleet clone or a worktree of one. The real path is tried first; the
// lexical path second, so a junction out of the workspace still names its clone.
/**
 * @param {string | undefined} cwd
 * @param {string} workspaceRoot
 * @param {(cwd: string) => string | null} [commonDir]
 * @returns {string | null}
 */
export function fleetRepoFor(cwd, workspaceRoot, commonDir = gitCommonDir) {
  if (!cwd || typeof cwd !== "string" || !workspaceRoot) return null;
  const realRoot = realPath(resolve(workspaceRoot));
  const real = repoNamedBy(
    realPath(resolve(cwd)),
    realRoot,
    realRoot,
    commonDir,
  );
  if (real) return real;
  return repoNamedBy(resolve(cwd), resolve(workspaceRoot), realRoot, commonDir);
}

// The same lookup for the adapters, which must not throw into the host: a git that cannot
// run is an unresolved directory, not a crash. The gate then applies its unknown-answer rule.
/**
 * @param {string | undefined} cwd
 * @param {string} workspaceRoot
 * @param {(cwd: string) => string | null} [commonDir]
 * @returns {{ repo: string | null, unresolved?: boolean }}
 */
export function fleetLookup(cwd, workspaceRoot, commonDir = gitCommonDir) {
  try {
    return { repo: fleetRepoFor(cwd, workspaceRoot, commonDir) };
  } catch {
    return { repo: null, unresolved: true };
  }
}
