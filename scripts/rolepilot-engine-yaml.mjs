import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const resumeAppPackageJsonPath = path.join(
  repoRoot,
  "apps",
  "rolepilot-engine",
  "package.json",
);
const requireFromResumeApp = createRequire(resumeAppPackageJsonPath);

export function resolveResumeAppYamlModulePath() {
  return requireFromResumeApp.resolve("yaml");
}

export async function loadResumeAppYamlModule() {
  const resolvedPath = resolveResumeAppYamlModulePath();
  const module = await import(pathToFileURL(resolvedPath).href);
  return module.default ?? module;
}

export async function parseResumeAppYaml(text) {
  const YAML = await loadResumeAppYamlModule();
  return YAML.parse(text);
}

export async function stringifyResumeAppYaml(value) {
  const YAML = await loadResumeAppYamlModule();
  return YAML.stringify(value);
}
