import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

export const WORKSPACE_ROOT = path.resolve(scriptsDir, "..");
export const WORKSPACE_DIST_READY_ENV = "ROLEPILOT_WORKSPACE_DIST_READY";

export const WORKSPACE_TARGETS = Object.freeze([
  Object.freeze({
    name: "platform-contracts",
    relativePath: path.join("packages", "platform-contracts"),
    build: null,
    check: true,
    test: true,
    buildForTests: false,
  }),
  Object.freeze({
    name: "web-contracts",
    relativePath: path.join("packages", "web-contracts"),
    build: "tsc",
    check: true,
    test: true,
    buildForTests: true,
  }),
  Object.freeze({
    name: "document-ingest",
    relativePath: path.join("packages", "document-ingest"),
    build: "tsc",
    check: true,
    test: true,
    buildForTests: true,
  }),
  Object.freeze({
    name: "platform-adapters",
    relativePath: path.join("packages", "platform-adapters"),
    build: "tsc",
    check: true,
    test: true,
    buildForTests: true,
  }),
  Object.freeze({
    name: "platform-runtime",
    relativePath: path.join("packages", "platform-runtime"),
    build: "tsc",
    check: true,
    test: true,
    buildForTests: true,
  }),
  Object.freeze({
    name: "platform-state",
    relativePath: path.join("packages", "platform-state"),
    build: "tsc",
    check: true,
    test: true,
    buildForTests: true,
  }),
  Object.freeze({
    name: "platform-policy",
    relativePath: path.join("packages", "platform-policy"),
    build: "tsc",
    check: true,
    test: true,
    buildForTests: true,
  }),
  Object.freeze({
    name: "platform-testkit",
    relativePath: path.join("packages", "platform-testkit"),
    build: "tsc",
    check: true,
    test: true,
    buildForTests: true,
  }),
  Object.freeze({
    name: "rolepilot-engine",
    relativePath: path.join("apps", "rolepilot-engine"),
    build: "tsc",
    check: true,
    test: true,
    buildForTests: true,
  }),
  Object.freeze({
    name: "rolepilot-web-service",
    relativePath: path.join("apps", "rolepilot-web-service"),
    build: "tsc",
    check: true,
    test: true,
    buildForTests: true,
  }),
  Object.freeze({
    name: "resume-workbench",
    relativePath: path.join("packages", "resume-workbench"),
    build: "script",
    check: true,
    test: true,
    buildForTests: false,
  }),
  Object.freeze({
    name: "rolepilot-web",
    relativePath: path.join("apps", "rolepilot-web"),
    build: "script",
    check: true,
    test: false,
    buildForTests: false,
  }),
]);

export const WORKSPACE_BUILD_TARGETS = Object.freeze(
  WORKSPACE_TARGETS.filter((target) => target.build),
);

export const WORKSPACE_TEST_BUILD_TARGETS = Object.freeze(
  WORKSPACE_TARGETS.filter((target) => target.buildForTests),
);

function resolveTarget(target) {
  if (typeof target === "string") {
    const definition = WORKSPACE_TARGETS.find((entry) => entry.name === target);
    if (!definition) {
      throw new Error(`Unknown workspace target: ${target}`);
    }
    return definition;
  }

  return target;
}

export function workspacePackageRoot(target, repoRoot = WORKSPACE_ROOT) {
  return path.join(repoRoot, resolveTarget(target).relativePath);
}

export function runPnpm(args, cwd = WORKSPACE_ROOT) {
  const result = spawnSync("pnpm", args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result;
}

export function buildFreshWorkspaceDist({
  repoRoot = WORKSPACE_ROOT,
  clean = true,
  targets = WORKSPACE_TEST_BUILD_TARGETS,
} = {}) {
  for (const target of targets) {
    const packageRoot = workspacePackageRoot(target, repoRoot);
    if (clean) {
      fs.rmSync(path.join(packageRoot, "dist"), {
        recursive: true,
        force: true,
      });
    }
    if (target.build === "tsc") {
      runPnpm(["exec", "tsc", "-p", "tsconfig.json"], packageRoot);
      continue;
    }
    if (target.build === "script") {
      runPnpm(["run", "build"], packageRoot);
      continue;
    }
    throw new Error(`Unsupported build type for ${target.name}: ${target.build}`);
  }
}

export function isWorkspaceDistReady(env = process.env) {
  return env[WORKSPACE_DIST_READY_ENV] === "1";
}

export function markWorkspaceDistReady(env = process.env) {
  env[WORKSPACE_DIST_READY_ENV] = "1";
}
