#!/usr/bin/env node
// The Node lcov reporter does not create its parent directory, so make
// coverage/ first, then run the suite with the same coverage command CI uses
// and write the report the fleet patch-coverage gate reads.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync("coverage", { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--experimental-test-coverage",
    "--test-reporter=lcov",
    "--test-reporter-destination=coverage/lcov.info",
  ],
  { windowsHide: true, stdio: "inherit" },
);
if (result.error) {
  process.stderr.write(`coverage: cannot run node: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
