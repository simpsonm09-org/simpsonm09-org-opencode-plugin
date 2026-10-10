// The adapters between the shared decision (gate.mjs) and the two repo-standard scripts
// it depends on: the access resolver and the GitHub App token broker. The OpenCode plugin
// (index.ts), the Claude Code hook, and the launcher all load them through this module,
// so the way a script is found, imported, spawned, and cached is written once. Every
// function here may touch the file system or spawn a process, which is why it lives apart
// from the pure gate.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fallbackLevel,
  nodeRunner,
  remoteUrlFor,
  tokenUsable,
} from "./gate.mjs";
import { timeoutFor } from "./lib/budget.mjs";

export const OWNER = "simpsonm09-org";

// Every child process and every broker call is bounded, so a stuck call becomes a
// fail-closed answer rather than a hang. The hook's budget (lib/budget.mjs) bounds the
// whole run on top of these.
const CHILD_TIMEOUT_MS = 10_000;
const MINT_TIMEOUT_MS = 20_000;

/**
 * @typedef {{ code: number, stdout: string }} CliResult
 * @typedef {{ token: string, expires_at: string }} TokenCache
 * @typedef {{
 *   loadCatalog: (path?: string) => unknown,
 *   loadCommittedCatalog?: (dir?: string) => unknown | null,
 *   resolveLevel: (catalog: unknown, repoName: string) => { level?: unknown },
 *   decide: (level: string, command: string, remoteUrl?: string | null) => { capability: string | null, allowed: boolean },
 * }} AccessApi
 * @typedef {{ mintForRepo: (owner: string, repo: string) => Promise<{ token: string, expires_at: string }> }} TokenApi
 */

// The resolver and broker in the repo-standard clone of a workspace.
/**
 * @param {string} workspaceRoot
 * @returns {{ access: string, token: string }}
 */
export function defaultScripts(workspaceRoot) {
  const repoStandard = join(
    workspaceRoot,
    "projects",
    "repos",
    "simpsonm09-repo-standard",
  );
  return {
    access: join(repoStandard, "scripts", "agent-access.mjs"),
    token: join(repoStandard, "scripts", "agent-token.mjs"),
  };
}

// Import a script and return its namespace, or null when it is missing or does not load.
/**
 * @param {string} script
 * @returns {Promise<any | null>}
 */
async function importModule(script) {
  if (!existsSync(script)) return null;
  try {
    return await import(pathToFileURL(script).href);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {value is AccessApi}
 */
function isAccessApi(value) {
  const api = /** @type {Partial<AccessApi> | null} */ (value);
  return (
    typeof api?.loadCatalog === "function" &&
    typeof api.resolveLevel === "function" &&
    typeof api.decide === "function"
  );
}

/**
 * @param {string} script
 * @returns {Promise<AccessApi | null>}
 */
export async function loadAccessApi(script) {
  const access = await importModule(script);
  return isAccessApi(access) ? access : null;
}

/**
 * @param {string} script
 * @returns {Promise<TokenApi | null>}
 */
export async function loadTokenApi(script) {
  const broker = await importModule(script);
  return broker && typeof broker.mintForRepo === "function" ? broker : null;
}

// The catalog the decision reads: the committed upstream ref first, then the working tree.
/**
 * @param {AccessApi} api
 * @returns {unknown}
 */
function catalogFor(api) {
  return api.loadCommittedCatalog?.() ?? api.loadCatalog();
}

// Decide one command with the resolver's own decide(). A resolver that throws is an
// unknown answer, which the decision treats conservatively.
/**
 * @param {AccessApi} api
 * @param {string} repo
 * @param {string} command
 * @param {string | null} remoteUrl
 * @returns {CliResult}
 */
function accessFromApi(api, repo, command, remoteUrl) {
  const resolved = api.resolveLevel(catalogFor(api), repo);
  const level =
    typeof resolved.level === "string" ? resolved.level : fallbackLevel();
  const decision = api.decide(level, command, remoteUrl);
  return {
    code: decision.allowed ? 0 : 1,
    stdout: JSON.stringify({
      level,
      capability: decision.capability,
      allowed: decision.allowed,
    }),
  };
}

// The last resort when the script exports no API: run it as a CLI with a Node runtime,
// never the OpenCode binary. The remote URL is passed only when it is known.
/**
 * @param {string} script
 * @param {string} repo
 * @param {string} command
 * @param {string | null} remoteUrl
 * @returns {CliResult}
 */
function accessFromCli(script, repo, command, remoteUrl) {
  const args = [script, repo, "--command", command, "--json"];
  if (remoteUrl) args.push("--remote-url", remoteUrl);
  try {
    const stdout = execFileSync(nodeRunner(process.execPath), args, {
      windowsHide: true,
      encoding: "utf8",
      timeout: timeoutFor(CHILD_TIMEOUT_MS),
    });
    return { code: 0, stdout: stdout ?? "" };
  } catch (error) {
    const failure =
      /** @type {{ status?: number | null, stdout?: string | Buffer }} */ (
        error
      );
    if (typeof failure?.status === "number")
      return { code: failure.status, stdout: String(failure.stdout ?? "") };
    return { code: 2, stdout: "" };
  }
}

// Resolve access for one command. The in-process module is preferred; a script that only
// ships a CLI is spawned with a Node runtime. A module that loads but then throws is an
// unknown answer (exit 2), not a crash.
/**
 * @param {AccessApi | null} api
 * @param {string | undefined} script
 * @param {string} repo
 * @param {string} command
 * @param {string | null} remoteUrl
 * @returns {CliResult}
 */
export function resolveAccess(api, script, repo, command, remoteUrl) {
  if (api) {
    try {
      return accessFromApi(api, repo, command, remoteUrl);
    } catch {
      return { code: 2, stdout: "" };
    }
  }
  if (!script || !existsSync(script)) return { code: 2, stdout: "" };
  return accessFromCli(script, repo, command, remoteUrl);
}

// The resolved level for the context line. The command decision is the authority; the
// level is informational.
/**
 * @param {AccessApi | null} api
 * @param {string} repo
 * @returns {string}
 */
export function levelFor(api, repo) {
  if (!api) return fallbackLevel();
  try {
    const resolved = api.resolveLevel(catalogFor(api), repo);
    return typeof resolved.level === "string"
      ? resolved.level
      : fallbackLevel();
  } catch {
    return fallbackLevel();
  }
}

// The token cache, one entry per repository. A token minted for one repository is never
// handed to another; that was the single-slot cache's defect.
/** @type {Map<string, TokenCache>} */
const tokenCache = new Map();

// Mint an installation token for one repository and cache it until it nears expiry. The
// token is never logged and never written to disk. A broker that does not answer in time
// is a failed mint.
/**
 * @param {TokenApi | null} api
 * @param {string} script
 * @param {string} repo
 * @returns {Promise<string | null>}
 */
export async function tokenFor(api, script, repo) {
  const cached = tokenCache.get(repo) ?? null;
  if (tokenUsable(cached, Date.now())) return cached?.token ?? null;
  const minted = await withTimeout(
    api ? mintInProcess(api, repo) : mintFromCli(script, repo),
    timeoutFor(MINT_TIMEOUT_MS),
  );
  if (!minted) return null;
  tokenCache.set(repo, minted);
  return minted.token;
}

// Resolve to null when the work does not finish in time, or fails.
/**
 * @template T
 * @param {Promise<T | null>} work
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
function withTimeout(work, ms) {
  let timer;
  const deadline = new Promise((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(null), ms);
  });
  return Promise.race([work.catch(() => null), deadline]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * @param {TokenApi} api
 * @param {string} repo
 * @returns {Promise<TokenCache | null>}
 */
async function mintInProcess(api, repo) {
  try {
    const minted = await api.mintForRepo(OWNER, repo);
    if (!minted?.token || !minted.expires_at) return null;
    return { token: minted.token, expires_at: minted.expires_at };
  } catch {
    return null;
  }
}

// A broker that only ships a CLI is spawned with a Node runtime. The CLI prints one JSON
// object on stdout.
/**
 * @param {string} script
 * @param {string} repo
 * @returns {Promise<TokenCache | null>}
 */
async function mintFromCli(script, repo) {
  if (!existsSync(script)) return null;
  try {
    const stdout = execFileSync(
      nodeRunner(process.execPath),
      [script, `${OWNER}/${repo}`, "--json"],
      {
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutFor(MINT_TIMEOUT_MS),
      },
    );
    const parsed = /** @type {Partial<TokenCache>} */ (
      JSON.parse(stdout ?? "")
    );
    if (!parsed.token || !parsed.expires_at) return null;
    return { token: parsed.token, expires_at: parsed.expires_at };
  } catch {
    return null;
  }
}

// The push URL of a remote, read with git in the directory. Not cached: a remote can be
// changed by any command, and a stale URL would decide a push wrongly.
/**
 * @param {string} remote
 * @param {string} cwd
 * @returns {string | null}
 */
export function gitRemoteUrl(remote, cwd) {
  return remoteUrlFor(remote, cwd, (args) =>
    execFileSync("git", args, {
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutFor(CHILD_TIMEOUT_MS),
    }),
  );
}
