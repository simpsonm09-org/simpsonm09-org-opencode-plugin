#!/usr/bin/env node
// Run one allowed gh command with a GitHub App installation token in its environment. The
// Claude Code PreToolUse hook rewrites an allowed gh call to `node <this file> <payload>`,
// because a hook cannot set the environment of the tool that runs the command. The token
// is minted here, in this process, and placed in the child's environment only. It is
// never printed by this file, never written to a file, and never part of the command text.
//
// The launcher does not trust the hook or the payload. Its workspace comes from its own
// realpath'd file location (lib/location.mjs), never from the working directory or the
// environment, so a planted workspace cannot choose the resolver or the broker. The
// payload's workspace and repository are hints it verifies. It then re-runs the same
// decision the hook makes (decideShell, gate.mjs) from its own working directory, and
// runs the command only when that decision is an allowed gh command for the repository
// the payload names. The whole command runs in Git Bash, as the Bash tool does, the same
// scope the OpenCode plugin gives an allowed gh command.
//
// A guardrail against mistakes, not a sandbox: a process running as the same user can
// reach the token broker directly. See "Known limits" in the README.
//
// Usage (written by the hook, not by hand):
//   node bin/with-gh-token.mjs <base64 payload>

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultScripts,
  gitRemoteUrl,
  loadAccessApi,
  loadTokenApi,
  resolveAccess,
  tokenFor,
} from "../access.mjs";
import { decideShell, denyMessage } from "../gate.mjs";
import { gitBashPath } from "../lib/bash.mjs";
import { fleetLookup } from "../lib/fleet.mjs";
import { realPath, workspaceForPluginRoot } from "../lib/location.mjs";
import { decodePayload } from "./payload.mjs";

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// The plugin root is the directory above bin/, as a real path, so a junction realpaths to
// the installed plugin.
const PLUGIN_ROOT = realPath(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);

// The workspace this launcher trusts: the one its own file sits in. options.workspaceRoot
// exists for the tests only; the command line never sets it.
/**
 * @param {{ workspaceRoot?: string }} [options]
 * @returns {string | null}
 */
export function trustedWorkspace(options = {}) {
  if (
    typeof options.workspaceRoot === "string" &&
    options.workspaceRoot.length > 0
  )
    return resolve(options.workspaceRoot);
  return workspaceForPluginRoot(PLUGIN_ROOT);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  const left = realPath(a);
  const right = realPath(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

// Re-decide the payload and, only for an allowed gh call for the repository it names, run
// it with the token. Resolves to the child's exit code, or 1 when the launcher refuses.
/**
 * @param {{ workspace: string, repo: string, command: string }} payload
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, shell?: string, powershell?: string, platform?: string, log?: (message: string) => void, workspaceRoot?: string }} [options]
 * @returns {Promise<number>}
 */
export async function launch(payload, options = {}) {
  const log = options.log ?? writeStderr;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const workspace = trustedWorkspace(options);
  if (!workspace) {
    log(
      denyMessage(
        "the launcher is not installed in a trusted workspace layout, so it trusts none",
      ),
    );
    return 1;
  }
  if (!samePath(payload.workspace, workspace)) {
    log(
      denyMessage(
        "the payload names a different workspace than the launcher's own",
      ),
    );
    return 1;
  }

  const shell = payload.shell === "powershell" ? "powershell" : "bash";
  const scripts = defaultScripts(workspace);
  const api = await loadAccessApi(scripts.access);
  const decision = decideShell(
    { command: payload.command, shell },
    {
      cwd,
      lookup: (dir) => fleetLookup(dir, workspace),
      resolve: (repo, text, remoteUrl) =>
        resolveAccess(api, scripts.access, repo, text, remoteUrl),
      remoteUrl: gitRemoteUrl,
    },
  );
  if (decision.action !== "inject" || decision.repo !== payload.repo) {
    log(
      denyMessage(
        decision.reason ??
          "the launcher runs only an allowed gh command for its repository",
      ),
    );
    return 1;
  }

  const host = childHost(shell, env, options);
  if (!host) {
    log(
      denyMessage(
        shell === "powershell"
          ? "PowerShell was not found"
          : "Git Bash was not found; set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe",
      ),
    );
    return 1;
  }

  const broker = await loadTokenApi(scripts.token);
  const token = await tokenFor(broker, scripts.token, decision.repo ?? "");
  if (!token) {
    log(
      denyMessage(`${decision.repo} could not mint a token for a gh command`),
    );
    return 1;
  }
  return runChild(
    host.file,
    host.args(payload.command),
    { ...env, GH_TOKEN: token },
    log,
  );
}

// The program that runs a command, and the arguments that pass it to that program. A bash
// command runs under Git Bash (or bash off Windows). A PowerShell command runs under
// PowerShell as -EncodedCommand, so the command reaches PowerShell as UTF-16 and no quoting of
// it is left to the Windows argument parser. The exit status is that of the last native
// command, which the appended line returns. Null when the shell is not installed.
/**
 * @param {"bash" | "powershell"} shell
 * @param {Record<string, string | undefined>} env
 * @param {{ shell?: string, powershell?: string, platform?: string }} options
 * @returns {{ file: string, args: (command: string) => string[] } | null}
 */
function childHost(shell, env, options) {
  const platform = options.platform ?? process.platform;
  if (shell === "powershell") {
    const file =
      options.powershell ?? (platform === "win32" ? "powershell.exe" : "pwsh");
    return {
      file,
      args: (command) => [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(`${command}\nexit $LASTEXITCODE`, "utf16le").toString(
          "base64",
        ),
      ],
    };
  }
  const file = options.shell ?? gitBashPath(env, platform);
  return file ? { file, args: (command) => ["-c", command] } : null;
}

// Run the program with its arguments and the token in its environment. The launcher's own
// termination stops the child, so the command does not outlive its launcher where a
// signal can be delivered. A forced kill cannot run this handler (see Known limits).
/**
 * @param {string} file
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @param {(message: string) => void} log
 * @returns {Promise<number>}
 */
function runChild(file, args, env, log) {
  return new Promise((resolveExit) => {
    const child = spawn(file, args, { windowsHide: true, stdio: "inherit", env });
    const stop = (signal) => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
    };
    const onExit = () => stop("SIGTERM");
    const detach = () => {
      for (const signal of STOP_SIGNALS) process.off(signal, stop);
      process.off("exit", onExit);
    };
    for (const signal of STOP_SIGNALS) process.on(signal, stop);
    process.on("exit", onExit);
    child.on("error", (error) => {
      detach();
      log(`agent-access: cannot start bash: ${error.message}`);
      resolveExit(1);
    });
    child.on("exit", (code, signal) => {
      detach();
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });
}

/**
 * @param {string} message
 */
function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}

async function main() {
  let payload;
  try {
    payload = decodePayload(process.argv[2]);
  } catch {
    writeStderr(
      denyMessage("the GitHub token launcher received no valid payload"),
    );
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = await launch(payload);
  } catch {
    writeStderr(denyMessage(`${payload.repo} could not run the gh command`));
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
