// Find the bash that runs an allowed gh command on Windows. Claude Code's Bash tool
// runs Git Bash there, and the launcher must use the same shell, because a bare
// "bash" can be WSL's bash.exe, which runs a different shell and does not receive
// GH_TOKEN. The order is CLAUDE_CODE_GIT_BASH_PATH when it is set, then the Git Bash
// beside the git on PATH. When neither exists the answer is null, and the caller
// fails closed. It never falls back to a bare "bash" on Windows.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 * @returns {string | null}
 */
export function gitBashPath(env = process.env, platform = process.platform) {
  if (platform !== "win32") return "bash";
  const configured = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (configured) return existsSync(configured) ? configured : null;
  try {
    const listed = execFileSync("where.exe", ["git"], {
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: LOOKUP_TIMEOUT_MS,
    });
    for (const line of listed.split(/\r?\n/)) {
      const gitExe = line.trim();
      if (!/\.exe$/i.test(gitExe)) continue;
      const candidate = join(dirname(dirname(gitExe)), "bin", "bash.exe");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // No git on PATH, or the lookup did not answer: there is no Git Bash to use.
  }
  return null;
}
