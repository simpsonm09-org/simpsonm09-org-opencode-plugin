#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const BASE = "main";

function git(args) {
  const result = spawnSync("git", args, { windowsHide: true, encoding: "utf8" });
  return {
    status: result.error ? 127 : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function prune(base = BASE) {
  const fetch = git(["fetch", "--all", "--prune"]);
  if (fetch.status !== 0) {
    return {
      ok: false,
      error: (fetch.stderr || fetch.stdout).trim(),
      deleted: [],
    };
  }
  git(["worktree", "prune"]);

  const listed = git(["branch", "--merged", base, "--format=%(refname:short)"]);
  if (listed.status !== 0) {
    return {
      ok: false,
      error: `cannot list branches merged into ${base}`,
      deleted: [],
    };
  }

  const current = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const keep = new Set([base, current, "HEAD"]);
  const deleted = [];
  for (const branch of listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    if (keep.has(branch)) continue;
    if (git(["branch", "-d", branch]).status === 0) deleted.push(branch);
  }
  return { ok: true, deleted };
}

function main() {
  const result = prune();
  if (!result.ok) {
    process.stderr.write(`prune: ${result.error}\n`);
    process.exit(1);
  }
  if (result.deleted.length === 0) {
    process.stdout.write(
      "prune: no local branch is merged to delete, remote refs pruned\n",
    );
  } else {
    for (const branch of result.deleted)
      process.stdout.write(`prune: deleted ${branch}\n`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
