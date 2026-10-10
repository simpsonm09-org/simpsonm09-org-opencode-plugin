#!/usr/bin/env node
// Resolve the agent access level for a fleet repository, and the capabilities
// that level grants. The policy lives in repo-catalog/repos.json. This is the
// one reader every enforcement point shares, so a level means the same thing to
// the pre-push hook, the OpenCode gate, and the credential broker.
//
// Usage:
//   node scripts/agent-access.mjs <repo-name> [--catalog <path>] [--json]
//   node scripts/agent-access.mjs <repo-name> --allows <capability> [--catalog <path>]
//   node scripts/agent-access.mjs <repo-name> --command "<shell command>" [--remote-url <url>] [--catalog <path>]
//
// The level mode prints the level and exits 0. The allows mode exits 0 when the
// repository's level grants the capability, and 1 when it does not. The command
// mode classifies a shell command to the capability it needs, then exits 0 when
// the level grants it and 1 when it does not. The optional remote URL scopes a
// git push: a push to a remote that is not the organization is out of scope and
// allowed, matching the pre-push hook. A missing catalog exits 2, so a caller
// fails closed on remote writes.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_DIR = join(ROOT, "..", "simpsonm09-repo-catalog");
const DEFAULT_CATALOG = join(CATALOG_DIR, "repos.json");

export const LEVELS = ["none", "read", "propose", "merge", "full"];

// A level grants a set of capabilities. Enforcement points ask for a
// capability, never for a level, so this table is the single mapping from the
// policy in policy.md to a decision.
export const CAPABILITIES = {
  none: [],
  read: ["read"],
  propose: ["read", "pushBranch", "openPr"],
  merge: ["read", "pushBranch", "openPr", "mergePr"],
  full: ["read", "pushBranch", "openPr", "mergePr", "pushMain", "admin"],
};

// The level an unknown repository or an unreadable catalog resolves to. It
// allows reading and local work, and denies every remote write.
export const FALLBACK_LEVEL = "read";

export function loadCatalog(path = DEFAULT_CATALOG) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Read the committed catalog from the clone, preferring the organization ref the
// agent cannot push to. This keeps the level out of the working tree, so an
// uncommitted edit cannot raise it.
export function loadCommittedCatalog(dir = CATALOG_DIR) {
  for (const ref of ["upstream/main", "main"]) {
    try {
      const out = execFileSync(
        "git",
        ["-C", dir, "show", `${ref}:repos.json`],
        {
          windowsHide: true,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      return JSON.parse(out);
    } catch {
      // Try the next ref, then give up.
    }
  }
  return null;
}

export function resolveLevel(catalog, repoName) {
  const entry = (catalog.repos ?? []).find((repo) => repo.name === repoName);
  if (!entry)
    return {
      repo: repoName,
      tier: null,
      level: FALLBACK_LEVEL,
      source: "unknown",
    };
  if (entry.agentAccess) {
    return {
      repo: repoName,
      tier: entry.tier,
      level: entry.agentAccess,
      source: "override",
    };
  }
  const level = catalog.agentAccessDefaults?.[entry.tier] ?? FALLBACK_LEVEL;
  return { repo: repoName, tier: entry.tier, level, source: "tier" };
}

export function allows(level, capability) {
  return (CAPABILITIES[level] ?? []).includes(capability);
}

// The organization remote the push hook governs. A push to any other remote is
// out of scope, so the gate leaves it to the hook's own scope rule.
const ORG_REMOTE_MARKER = "simpsonm09-org";

// A shell command needs one capability. The patterns are ordered, first match
// wins, so the specific merge and create checks run before the generic push.
// An unmatched command needs no capability: it does not reach GitHub, so the
// level does not govern it and it is allowed.
const COMMAND_RULES = [
  {
    capability: "mergePr",
    test: (parts) =>
      parts[0] === "gh" && parts[1] === "pr" && parts[2] === "merge",
  },
  {
    capability: "openPr",
    test: (parts) =>
      parts[0] === "gh" && parts[1] === "pr" && parts[2] === "create",
  },
  {
    capability: "pushMain",
    test: (parts) => isGitPush(parts) && gitPushRefspecs(parts).some(isMainRef),
  },
  { capability: "pushBranch", test: (parts) => isGitPush(parts) },
  {
    capability: "admin",
    test: (parts) =>
      parts[0] === "gh" && parts[1] === "api" && isWriteMethod(parts),
  },
];

function isGitPush(parts) {
  return parts[0] === "git" && parts[1] === "push";
}

// Parse the tokens after "git push". A flag token starts with "-" and is
// skipped. The first non-flag token is the remote only when it is not a
// refspec: a token naming a ref ("main", "refs/heads/x", or "X:Y") is a
// refspec even in the remote position. Every remaining non-flag token is a
// refspec. This handles a flag or flags between "push" and the remote or ref,
// as in "git push --dry-run origin main".
function gitPushTarget(parts) {
  const tokens = parts.slice(2).filter((token) => !token.startsWith("-"));
  const remote =
    tokens[0] && !looksLikeRefspec(tokens[0]) ? tokens[0] : undefined;
  const refspecs = remote ? tokens.slice(1) : tokens;
  return { remote, refspecs };
}

function gitPushRefspecs(parts) {
  return gitPushTarget(parts).refspecs;
}

// A refspec names a ref. "main" and "refs/heads/main" are the shorthand and the
// full form. A colon separates source and destination ("X:main", ":main"), and
// the leading colon alone is a deletion. A bare remote name has no colon and no
// slash, and does not start with a ref prefix, so it reads as a remote.
function looksLikeRefspec(token) {
  if (token.includes(":")) return true;
  if (
    token === "HEAD" ||
    token.startsWith("refs/") ||
    token.startsWith("refs\\")
  )
    return true;
  if (!token.includes("/")) return false;
  const [head] = token.split(/[/\\]/);
  return head === "refs" || head === "heads";
}

// git push <remote> <refspec>. Bare "main" expands to refs/heads/main. A
// refspec with a colon separates source and destination ("X:main", ":main",
// "feat/x:main"), and the destination is the ref the remote writes, so the
// part after the colon is the one tested.
function isMainRef(refspec) {
  const value = refspec ?? "";
  const ref = value.includes(":") ? value.slice(value.indexOf(":") + 1) : value;
  return ref === "main" || ref === "refs/heads/main";
}

// A git push is governed only when it targets the organization remote. When the
// remote URL is known and is not the organization, the push is out of scope and
// needs no capability, which matches the pre-push hook's URL scope. When the URL
// is unknown, the push stays governed, so the gate keeps its current behavior.
function pushInScope(parts, remoteUrl) {
  if (!isGitPush(parts)) return true;
  if (!remoteUrl) return true;
  return remoteUrl.includes(ORG_REMOTE_MARKER);
}

// gh api mutates only when it names an explicit HTTP method. The method comes
// from the next token after -X or --method, or from a --method=... form.
function isWriteMethod(parts) {
  const write = ["POST", "PUT", "PATCH", "DELETE"];
  for (let index = 0; index < parts.length; index += 1) {
    const arg = parts[index];
    const value =
      arg === "-X" || arg === "--method"
        ? parts[index + 1]
        : arg.startsWith("--method=")
          ? arg.slice("--method=".length)
          : null;
    if (value && write.includes(value.toUpperCase())) return true;
  }
  return false;
}

// Split a shell command on whitespace and quotes. It is not a full shell parse,
// only enough to reach the command and its git refspec. A command with no match
// classifies to null, which decide treats as allowed. A git push whose known
// remote URL is not the organization classifies to null: the hook is out of
// scope for it, so the gate is too.
export function classify(command, remoteUrl) {
  const parts = tokenize(command);
  if (!pushInScope(parts, remoteUrl)) return null;
  const rule = COMMAND_RULES.find((candidate) => candidate.test(parts));
  return rule ? rule.capability : null;
}

function tokenize(command) {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

// A null classification needs no capability, so it is allowed at every level.
export function decide(level, command, remoteUrl) {
  const capability = classify(command, remoteUrl);
  return capability === null
    ? { capability, allowed: true }
    : { capability, allowed: allows(level, capability) };
}

export function selfTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const fixture = {
    agentAccessDefaults: {
      standard: "read",
      feature: "propose",
      legacy: "none",
    },
    repos: [
      { name: "tier-default", tier: "standard" },
      { name: "feature-default", tier: "feature" },
      { name: "override", tier: "feature", agentAccess: "merge" },
      { name: "legacy", tier: "legacy" },
    ],
  };

  assert(
    resolveLevel(fixture, "tier-default").level === "read",
    "tier default",
  );
  assert(
    resolveLevel(fixture, "feature-default").level === "propose",
    "feature default",
  );
  const override = resolveLevel(fixture, "override");
  assert(
    override.level === "merge" && override.source === "override",
    "per-repo override",
  );
  assert(resolveLevel(fixture, "legacy").level === "none", "legacy default");
  const unknown = resolveLevel(fixture, "not-listed");
  assert(
    unknown.level === FALLBACK_LEVEL && unknown.source === "unknown",
    "unknown repository",
  );

  for (const level of LEVELS)
    assert(Array.isArray(CAPABILITIES[level]), `capabilities for ${level}`);
  assert(allows("none", "read") === false, "none denies read");
  assert(
    allows("read", "read") && allows("read", "pushBranch") === false,
    "read capabilities",
  );
  assert(
    allows("propose", "pushBranch") && allows("propose", "mergePr") === false,
    "propose capabilities",
  );
  assert(
    allows("merge", "mergePr") && allows("merge", "pushMain") === false,
    "merge capabilities",
  );
  assert(
    allows("full", "pushMain") && allows("full", "admin"),
    "full capabilities",
  );

  const fork = "https://github.com/simpsonm09/simpsonm09-repo-standard.git";
  const org = "https://github.com/simpsonm09-org/simpsonm09-repo-standard.git";

  const table = [
    ["gh pr merge 1", "mergePr"],
    ["gh pr create --title x", "openPr"],
    ["git push origin main", "pushMain"],
    ["git push upstream refs/heads/main", "pushMain"],
    ["git push origin main --force-with-lease", "pushMain"],
    ["git push origin feat/x", "pushBranch"],
    ["git push origin :main", "pushMain"],
    ["git push origin feat/x:main", "pushMain"],
    ["git push --dry-run origin main", "pushMain"],
    ["git push -f origin main", "pushMain"],
    ["git push --force-with-lease origin refs/heads/main", "pushMain"],
    ["git push --dry-run origin feat/x", "pushBranch"],
    ["git push --dry-run", "pushBranch"],
    ["git push origin", "pushBranch"],
    ["git push", "pushBranch"],
    ["gh api repos/o/r --method PATCH", "admin"],
    ["gh api -X DELETE repos/o/r", "admin"],
    ["gh api --method=POST repos/o/r", "admin"],
    ["gh api --method=delete repos/o/r", "admin"],
    ["gh api -X get repos/o/r", null],
    ["gh api repos/o/r", null],
    ["gh api -X GET repos/o/r", null],
    ["gh pr view 1", null],
    ["npm test", null],
    ["git status", null],
    ["", null],
  ];
  for (const [command, expected] of table) {
    assert(
      classify(command) === expected,
      `classify ${JSON.stringify(command)} -> ${expected}`,
    );
  }

  // A propose level denies a push to the organization main but allows the same
  // push to the fork, because the flag case classifies the first and the scope
  // rules the second out.
  const allowed = [
    ["read", "gh pr merge 1", false],
    ["read", "gh pr create", false],
    ["propose", "gh pr create", true],
    ["propose", "gh pr merge 1", false],
    ["merge", "gh pr merge 1", true],
    ["merge", "git push origin main", false],
    ["full", "git push origin main", true],
    ["none", "npm test", true],
    ["read", "gh api -X POST repos/o/r", false],
    ["full", "gh api -X POST repos/o/r", true],
  ];
  for (const [level, command, expected] of allowed) {
    assert(
      decide(level, command).allowed === expected,
      `decide ${level} ${JSON.stringify(command)} -> ${expected}`,
    );
  }

  assertPushScope(assert, fork, org);
}

// The push scope coverage: a known non-organization remote is out of scope and
// needs no capability, the organization remote keeps the governed capability,
// and an unknown URL stays governed. Split from selfTest so each stays short.
function assertPushScope(assert, fork, org) {
  const scoped = [
    ["git push --dry-run origin main", fork, null],
    ["git push --dry-run origin main", org, "pushMain"],
    ["git push upstream feat/x", fork, null],
    ["git push upstream feat/x", org, "pushBranch"],
    ["git push origin main", fork, null],
    ["git push origin main", undefined, "pushMain"],
    ["git push origin main", "", "pushMain"],
  ];
  for (const [command, remoteUrl, expected] of scoped) {
    assert(
      classify(command, remoteUrl) === expected,
      `classify ${JSON.stringify(command)} @ ${remoteUrl} -> ${expected}`,
    );
  }

  const decided = [
    ["propose", "git push --dry-run origin main", org, false],
    ["propose", "git push --dry-run origin main", fork, true],
    ["propose", "git push upstream feat/x", org, true],
    ["merge", "git push --dry-run origin main", org, false],
    ["full", "git push --dry-run origin main", org, true],
  ];
  for (const [level, command, remoteUrl, expected] of decided) {
    assert(
      decide(level, command, remoteUrl).allowed === expected,
      `decide ${level} ${JSON.stringify(command)} @ ${remoteUrl} -> ${expected}`,
    );
  }
}

function parseArgs(argv) {
  const args = {
    repo: undefined,
    catalog: undefined,
    allows: undefined,
    command: undefined,
    remoteUrl: undefined,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--catalog") {
      index += 1;
      args.catalog = argv[index];
    } else if (arg === "--allows") {
      index += 1;
      args.allows = argv[index];
    } else if (arg === "--command") {
      index += 1;
      args.command = argv[index];
    } else if (arg === "--remote-url") {
      index += 1;
      args.remoteUrl = argv[index];
    } else if (arg === "--json") args.json = true;
    else if (!args.repo) args.repo = arg;
  }
  return args;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const args = parseArgs(argv);
  if (!args.repo) return usageAndExit();

  const catalog = loadCatalogFromArgs(args);
  const resolved = resolveLevel(catalog, args.repo);
  const capabilities = CAPABILITIES[resolved.level] ?? [];

  if (args.command !== undefined) {
    const { capability, allowed } = decide(
      resolved.level,
      args.command,
      args.remoteUrl,
    );
    if (args.json)
      process.stdout.write(
        `${JSON.stringify({ ...resolved, capability, allowed })}\n`,
      );
    process.exit(allowed ? 0 : 1);
  }
  if (args.allows) process.exit(capabilities.includes(args.allows) ? 0 : 1);
  if (args.json)
    process.stdout.write(`${JSON.stringify({ ...resolved, capabilities })}\n`);
  else process.stdout.write(`${resolved.level}\n`);
}

function runSelfTest() {
  try {
    selfTest();
    process.stdout.write("agent-access: self-test ok\n");
  } catch (error) {
    process.stderr.write(`agent-access: self-test failed: ${error.message}\n`);
    process.exit(1);
  }
}

function usageAndExit() {
  process.stderr.write(
    'usage: agent-access <repo-name> [--catalog <path>] [--json] [--allows <capability>] [--command "<shell command>"] [--remote-url <url>]\n',
  );
  process.exit(2);
}

function loadCatalogFromArgs(args) {
  try {
    return args.catalog
      ? loadCatalog(args.catalog)
      : (loadCommittedCatalog() ?? loadCatalog(DEFAULT_CATALOG));
  } catch {
    process.stderr.write(
      "agent-access: cannot read the catalog, denying remote writes\n",
    );
    process.exit(2);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
