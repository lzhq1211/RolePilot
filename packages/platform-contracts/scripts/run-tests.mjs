import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildFreshWorkspaceDist,
  isWorkspaceDistReady,
  WORKSPACE_ROOT,
} from "../../../scripts/workspace-build.mjs";

const repoRoot = WORKSPACE_ROOT;
const testsDir = path.join(repoRoot, "tests", "contracts");
const GOVERNANCE_TEST_NAMES = Object.freeze([
  "docs-contract.test.mjs",
  "workflow-contract.test.mjs",
  "offline-eval.test.mjs",
]);
const allTestFiles = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testsDir, name));

function runOrExit(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.error) {
    throw result.error;
  }
}

const rawArgs = process.argv.slice(2);
const argv = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

const passthrough = [];
let grepPattern = null;
let governanceOnly = false;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--governance") {
    governanceOnly = true;
    continue;
  }
  if (arg === "--grep") {
    grepPattern = argv[index + 1] || "";
    passthrough.push("--test-name-pattern", grepPattern);
    index += 1;
    continue;
  }
  passthrough.push(arg);
}

let testFiles = governanceOnly
  ? allTestFiles.filter((filePath) =>
      GOVERNANCE_TEST_NAMES.includes(path.basename(filePath)),
    )
  : allTestFiles;

if (grepPattern) {
  testFiles = testFiles.filter((filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      return new RegExp(grepPattern).test(content);
    });
}

if (!isWorkspaceDistReady()) {
  buildFreshWorkspaceDist({ repoRoot });
}

const result = spawnSync(
  process.execPath,
  ["--test", ...passthrough, ...testFiles],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);

if (typeof result.status === "number") {
  process.exit(result.status);
}

throw result.error || new Error("Test runner failed to start");
