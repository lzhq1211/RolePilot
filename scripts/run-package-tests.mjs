import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildFreshWorkspaceDist,
  isWorkspaceDistReady,
  WORKSPACE_ROOT,
} from "./workspace-build.mjs";

const packageRoot = process.cwd();
const testsDir = path.join(packageRoot, "tests");
const repoRoot = WORKSPACE_ROOT;

function collectTests(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTests(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      files.push(fullPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function createPatternMatcher(pattern) {
  if (!pattern) {
    return null;
  }

  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(`Invalid --grep pattern: ${error.message}`);
  }
}

function filterTestFiles(files, pattern) {
  const matcher = createPatternMatcher(pattern);
  if (!matcher) {
    return files;
  }

  const matched = files.filter((filePath) => {
    const normalizedPath = filePath.replaceAll("\\", "/");
    if (matcher.test(normalizedPath)) {
      return true;
    }

    const source = fs.readFileSync(filePath, "utf8");
    return matcher.test(source);
  });

  if (matched.length === 0) {
    return [];
  }

  return matched;
}

if (!fs.existsSync(testsDir)) {
  throw new Error(`No tests directory found in ${packageRoot}`);
}

const incomingArgs = process.argv.slice(2);
const nodeArgs = ["--test"];
let grepPattern = null;
let ciMode = false;

for (let index = 0; index < incomingArgs.length; index += 1) {
  const arg = incomingArgs[index];
  if (arg === "--") {
    continue;
  }
  if (arg === "--ci") {
    ciMode = true;
    continue;
  }
  if (arg === "--grep") {
    const pattern = incomingArgs[index + 1];
    if (!pattern) {
      throw new Error("--grep requires a pattern");
    }
    grepPattern = pattern;
    nodeArgs.push("--test-name-pattern", pattern);
    index += 1;
    continue;
  }

  nodeArgs.push(arg);
}

const env = {
  ...process.env,
};

if (ciMode) {
  env.CI = "true";
}

const testFiles = filterTestFiles(collectTests(testsDir), grepPattern);
if (testFiles.length === 0) {
  process.exit(0);
}
if (!isWorkspaceDistReady()) {
  buildFreshWorkspaceDist({ repoRoot });
}
const result = spawnSync(process.execPath, [...nodeArgs, ...testFiles], {
  cwd: packageRoot,
  env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
