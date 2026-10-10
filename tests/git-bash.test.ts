// The Git Bash lookup (lib/bash.mjs) on Windows with no configured path. It runs `where.exe git`
// for real, so the answer depends on the machine: the Git Bash beside the git on PATH, or null.
// It never answers a bare "bash", and a machine with no where.exe or no git fails closed to null.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { test } from "node:test";
import { gitBashPath } from "../lib/bash.mjs";

test("on win32 with no configured Git Bash, the lookup answers an existing bash.exe or null, never bare bash", () => {
  const found = gitBashPath({}, "win32");
  assert.ok(
    found === null ||
      (basename(found).toLowerCase() === "bash.exe" && existsSync(found)),
    `expected an existing bash.exe or null, got ${JSON.stringify(found)}`,
  );
});
