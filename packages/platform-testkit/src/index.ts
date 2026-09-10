import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLATFORM_TESTKIT_BOUNDARY = {
  packageName: "platform-testkit",
  layer: "testkit",
  fixtures: "offline-fixtures-and-stub-playback",
  offlineSafe: true,
} as const;

const FIXTURES_ROOT = fileURLToPath(new URL("../fixtures", import.meta.url));

export const REVIEW_FIXTURE_NAMES = [
  "canonical-pass",
  "pass",
  "revise",
  "need-role-info",
  "malformed",
  "semantic-invalid",
  "invalid-semantic",
  "legacy-real-artifact",
] as const;

export const PREFLIGHT_FIXTURE_NAMES = [
  "proceed",
  "ask-user",
  "stop-unsupported",
] as const;

export const OPTIMIZATION_FIXTURE_NAMES = [
  "valid-actions",
  "invalid-actions",
] as const;

export const REVIEW_FIXTURE_SEMANTICS = {
  pass: "pass",
  revise: "revise",
  malformed: "malformed",
  "semantic-invalid": "semantic-invalid",
  "invalid-semantic": "semantic-invalid",
  "legacy-real-artifact": "legacy-real-artifact",
  "canonical-pass": "pass",
  "need-role-info": "need-role-info",
} as const satisfies Record<ReviewFixtureName, string>;

export const RUN_FIXTURE_NAMES = ["loop-score-sequence"] as const;

export const INTEGRATION_FIXTURE_NAMES = [
  "company",
  "resume",
  "timeline",
] as const;

export type ReviewFixtureName = (typeof REVIEW_FIXTURE_NAMES)[number];
export type PreflightFixtureName = (typeof PREFLIGHT_FIXTURE_NAMES)[number];
export type OptimizationFixtureName =
  (typeof OPTIMIZATION_FIXTURE_NAMES)[number];
export type RunFixtureName = (typeof RUN_FIXTURE_NAMES)[number];
export type IntegrationFixtureName = (typeof INTEGRATION_FIXTURE_NAMES)[number];
export type FixtureCollection =
  | "review"
  | "preflight"
  | "optimization"
  | "run"
  | "integration";

export type StubResponseEntry =
  | string
  | {
      text?: string;
      file?: string;
      responseFile?: string;
    };

export type AgentStubConfig = Record<
  string,
  StubResponseEntry | StubResponseEntry[]
>;

export type AgentStubState = {
  readonly stubPath: string;
  readonly stubDir: string;
  readonly agents: Record<string, StubResponseEntry[]>;
};

type JsonObject = Record<string, unknown>;

type JsonObjectValidator<T extends JsonObject> = (
  value: JsonObject,
) => value is T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseJsonObject(source: string, label: string): JsonObject {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label}: ${reason}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return parsed;
}

const FIXTURE_FILE_NAMES = {
  review: {
    "canonical-pass": "canonical-pass.json",
    pass: "pass.json",
    revise: "revise.json",
    "need-role-info": "need-role-info.json",
    malformed: "malformed.json",
    "semantic-invalid": "semantic-invalid.json",
    "invalid-semantic": "invalid-semantic.json",
    "legacy-real-artifact": "legacy-real-artifact.json",
  },
  preflight: {
    proceed: "proceed.json",
    "ask-user": "ask-user.json",
    "stop-unsupported": "stop-unsupported.json",
  },
  optimization: {
    "valid-actions": "valid-actions.json",
    "invalid-actions": "invalid-actions.json",
  },
  run: {
    "loop-score-sequence": "loop-score-sequence.json",
  },
  integration: {
    company: "company.json",
    resume: "resume.yml",
    timeline: "timeline.yml",
  },
} as const;

export function describePlatformTestkitBoundary() {
  return `${PLATFORM_TESTKIT_BOUNDARY.packageName}:${PLATFORM_TESTKIT_BOUNDARY.layer}`;
}

export function getFixturesRoot() {
  return FIXTURES_ROOT;
}

export function getFixturePath(
  collection: "review",
  name: ReviewFixtureName,
): string;
export function getFixturePath(
  collection: "preflight",
  name: PreflightFixtureName,
): string;
export function getFixturePath(
  collection: "optimization",
  name: OptimizationFixtureName,
): string;
export function getFixturePath(collection: "run", name: RunFixtureName): string;
export function getFixturePath(
  collection: "integration",
  name: IntegrationFixtureName,
): string;
export function getFixturePath(
  collection: FixtureCollection,
  name:
    | ReviewFixtureName
    | PreflightFixtureName
    | OptimizationFixtureName
    | RunFixtureName
    | IntegrationFixtureName,
): string {
  let fileName: string | undefined;

  switch (collection) {
    case "review":
      fileName = FIXTURE_FILE_NAMES.review[name as ReviewFixtureName];
      break;
    case "preflight":
      fileName = FIXTURE_FILE_NAMES.preflight[name as PreflightFixtureName];
      break;
    case "optimization":
      fileName =
        FIXTURE_FILE_NAMES.optimization[name as OptimizationFixtureName];
      break;
    case "run":
      fileName = FIXTURE_FILE_NAMES.run[name as RunFixtureName];
      break;
    case "integration":
      fileName = FIXTURE_FILE_NAMES.integration[name as IntegrationFixtureName];
      break;
  }

  if (!fileName) {
    throw new Error(`Unknown ${collection} fixture: ${name}`);
  }

  return path.join(FIXTURES_ROOT, collection, fileName);
}

export function loadFixtureText(
  collection: "review",
  name: ReviewFixtureName,
): string;
export function loadFixtureText(
  collection: "preflight",
  name: PreflightFixtureName,
): string;
export function loadFixtureText(
  collection: "optimization",
  name: OptimizationFixtureName,
): string;
export function loadFixtureText(
  collection: "run",
  name: RunFixtureName,
): string;
export function loadFixtureText(
  collection: "integration",
  name: IntegrationFixtureName,
): string;
export function loadFixtureText(
  collection: FixtureCollection,
  name:
    | ReviewFixtureName
    | PreflightFixtureName
    | OptimizationFixtureName
    | RunFixtureName
    | IntegrationFixtureName,
): string {
  return fs.readFileSync(
    getFixturePath(collection as never, name as never),
    "utf8",
  );
}

export function loadReviewFixtureText(name: ReviewFixtureName) {
  return loadFixtureText("review", name);
}

export function loadPreflightFixtureText(name: PreflightFixtureName) {
  return loadFixtureText("preflight", name);
}

export function loadOptimizationFixtureText(name: OptimizationFixtureName) {
  return loadFixtureText("optimization", name);
}

export function loadRunFixtureText(name: RunFixtureName) {
  return loadFixtureText("run", name);
}

export function loadIntegrationFixtureText(name: IntegrationFixtureName) {
  return loadFixtureText("integration", name);
}

export function loadJsonFixture(
  collection: "review",
  name: ReviewFixtureName,
): JsonObject;
export function loadJsonFixture<T extends JsonObject>(
  collection: "review",
  name: ReviewFixtureName,
  validator: JsonObjectValidator<T>,
): T;
export function loadJsonFixture(
  collection: "preflight",
  name: PreflightFixtureName,
): JsonObject;
export function loadJsonFixture<T extends JsonObject>(
  collection: "preflight",
  name: PreflightFixtureName,
  validator: JsonObjectValidator<T>,
): T;
export function loadJsonFixture(
  collection: "optimization",
  name: OptimizationFixtureName,
): JsonObject;
export function loadJsonFixture<T extends JsonObject>(
  collection: "optimization",
  name: OptimizationFixtureName,
  validator: JsonObjectValidator<T>,
): T;
export function loadJsonFixture(
  collection: "run",
  name: RunFixtureName,
): JsonObject;
export function loadJsonFixture<T extends JsonObject>(
  collection: "run",
  name: RunFixtureName,
  validator: JsonObjectValidator<T>,
): T;
export function loadJsonFixture(
  collection: "integration",
  name: Extract<IntegrationFixtureName, "company">,
): JsonObject;
export function loadJsonFixture<T extends JsonObject>(
  collection: "integration",
  name: Extract<IntegrationFixtureName, "company">,
  validator: JsonObjectValidator<T>,
): T;
export function loadJsonFixture<T extends JsonObject>(
  collection: FixtureCollection,
  name:
    | ReviewFixtureName
    | PreflightFixtureName
    | OptimizationFixtureName
    | RunFixtureName
    | IntegrationFixtureName,
  validator?: JsonObjectValidator<T>,
): JsonObject | T {
  const source = loadFixtureText(collection as never, name as never);
  const parsed = parseJsonObject(source, `${collection} fixture \"${name}\"`);

  if (!validator) {
    return parsed;
  }

  if (!validator(parsed)) {
    throw new Error(`${collection} fixture \"${name}\" is invalid.`);
  }

  return parsed;
}

export function cloneJsonFixture(
  collection: "review",
  name: ReviewFixtureName,
): JsonObject;
export function cloneJsonFixture<T extends JsonObject>(
  collection: "review",
  name: ReviewFixtureName,
  validator: JsonObjectValidator<T>,
): T;
export function cloneJsonFixture(
  collection: "preflight",
  name: PreflightFixtureName,
): JsonObject;
export function cloneJsonFixture<T extends JsonObject>(
  collection: "preflight",
  name: PreflightFixtureName,
  validator: JsonObjectValidator<T>,
): T;
export function cloneJsonFixture(
  collection: "optimization",
  name: OptimizationFixtureName,
): JsonObject;
export function cloneJsonFixture<T extends JsonObject>(
  collection: "optimization",
  name: OptimizationFixtureName,
  validator: JsonObjectValidator<T>,
): T;
export function cloneJsonFixture(
  collection: "run",
  name: RunFixtureName,
): JsonObject;
export function cloneJsonFixture<T extends JsonObject>(
  collection: "run",
  name: RunFixtureName,
  validator: JsonObjectValidator<T>,
): T;
export function cloneJsonFixture(
  collection: "integration",
  name: Extract<IntegrationFixtureName, "company">,
): JsonObject;
export function cloneJsonFixture<T extends JsonObject>(
  collection: "integration",
  name: Extract<IntegrationFixtureName, "company">,
  validator: JsonObjectValidator<T>,
): T;
export function cloneJsonFixture<T extends JsonObject>(
  collection: FixtureCollection,
  name:
    | ReviewFixtureName
    | PreflightFixtureName
    | OptimizationFixtureName
    | RunFixtureName
    | IntegrationFixtureName,
  validator?: JsonObjectValidator<T>,
): JsonObject | T {
  const fixture = validator
    ? loadJsonFixture(collection as never, name as never, validator)
    : loadJsonFixture(collection as never, name as never);

  return structuredClone(fixture);
}

export function loadReviewFixtureJson(name: ReviewFixtureName): JsonObject;
export function loadReviewFixtureJson<T extends JsonObject>(
  name: ReviewFixtureName,
  validator: JsonObjectValidator<T>,
): JsonObject | T;
export function loadReviewFixtureJson<T extends JsonObject>(
  name: ReviewFixtureName,
  validator?: JsonObjectValidator<T>,
) {
  return validator
    ? loadJsonFixture("review", name, validator)
    : loadJsonFixture("review", name);
}

export function loadPreflightFixtureJson(name: PreflightFixtureName): JsonObject;
export function loadPreflightFixtureJson<T extends JsonObject>(
  name: PreflightFixtureName,
  validator: JsonObjectValidator<T>,
): JsonObject | T;
export function loadPreflightFixtureJson<T extends JsonObject>(
  name: PreflightFixtureName,
  validator?: JsonObjectValidator<T>,
) {
  return validator
    ? loadJsonFixture("preflight", name, validator)
    : loadJsonFixture("preflight", name);
}

export function loadOptimizationFixtureJson(
  name: OptimizationFixtureName,
): JsonObject;
export function loadOptimizationFixtureJson<T extends JsonObject>(
  name: OptimizationFixtureName,
  validator: JsonObjectValidator<T>,
): JsonObject | T;
export function loadOptimizationFixtureJson<T extends JsonObject>(
  name: OptimizationFixtureName,
  validator?: JsonObjectValidator<T>,
) {
  return validator
    ? loadJsonFixture("optimization", name, validator)
    : loadJsonFixture("optimization", name);
}

export function loadRunFixtureJson(name: RunFixtureName): JsonObject;
export function loadRunFixtureJson<T extends JsonObject>(
  name: RunFixtureName,
  validator: JsonObjectValidator<T>,
): JsonObject | T;
export function loadRunFixtureJson<T extends JsonObject>(
  name: RunFixtureName,
  validator?: JsonObjectValidator<T>,
) {
  return validator
    ? loadJsonFixture("run", name, validator)
    : loadJsonFixture("run", name);
}

export function loadIntegrationCompanyFixture(): JsonObject;
export function loadIntegrationCompanyFixture<T extends JsonObject>(
  validator: JsonObjectValidator<T>,
): JsonObject | T;
export function loadIntegrationCompanyFixture<T extends JsonObject>(
  validator?: JsonObjectValidator<T>,
) {
  return validator
    ? loadJsonFixture("integration", "company", validator)
    : loadJsonFixture("integration", "company");
}

export function resolveAgentStubPath(
  stubPath: string,
  options: { cwd?: string } = {},
) {
  const trimmed = stubPath.trim();
  if (!trimmed) {
    throw new Error("Stub file path must not be empty.");
  }

  return path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(options.cwd ?? process.cwd(), trimmed);
}

function normalizeStubConfig(
  raw: unknown,
): Record<string, StubResponseEntry[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "Stub queue file must be a JSON object keyed by agent name.",
    );
  }

  return Object.fromEntries(
    Object.entries(raw).map(([agentName, entries]) => [
      agentName,
      Array.isArray(entries) ? [...entries] : [entries],
    ]),
  );
}

export function createAgentStubState(
  config: AgentStubConfig,
  stubPath = "<inline>",
): AgentStubState {
  return {
    stubPath,
    stubDir: path.dirname(stubPath),
    agents: normalizeStubConfig(config),
  };
}

export function loadAgentStubStateFromFile(
  stubFilePath: string,
  options: { cwd?: string } = {},
): AgentStubState {
  const resolvedPath = resolveAgentStubPath(stubFilePath, options);
  const raw = parseJsonObject(
    fs.readFileSync(resolvedPath, "utf8"),
    `stub queue file \"${resolvedPath}\"`,
  );

  return {
    stubPath: resolvedPath,
    stubDir: path.dirname(resolvedPath),
    agents: normalizeStubConfig(raw),
  };
}

export function loadAgentStubStateFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { cwd?: string } = {},
) {
  const stubPath = String(env.ORCHESTRATE_AGENT_STUB_FILE ?? "").trim();
  if (!stubPath) {
    return null;
  }

  return loadAgentStubStateFromFile(stubPath, options);
}

export function resolveStubResponse(
  entry: StubResponseEntry,
  state: AgentStubState,
) {
  if (typeof entry === "string") {
    return entry;
  }

  if (!entry || typeof entry !== "object") {
    throw new Error("Stub response must be a string or object.");
  }

  if (typeof entry.text === "string") {
    return entry.text;
  }

  const responseFile = entry.file ?? entry.responseFile;
  if (typeof responseFile === "string" && responseFile.trim()) {
    const absolutePath = path.isAbsolute(responseFile)
      ? responseFile
      : path.resolve(state.stubDir, responseFile);
    return fs.readFileSync(absolutePath, "utf8");
  }

  throw new Error("Stub response is missing text or file.");
}

export function takeAgentStubResponse(
  agentName: string,
  state: AgentStubState,
) {
  const queue = state.agents[agentName];
  if (!queue || queue.length === 0) {
    throw new Error(`No stub response configured for agent \"${agentName}\".`);
  }

  const next = queue.shift();
  if (next === undefined) {
    throw new Error(`No stub response configured for agent \"${agentName}\".`);
  }

  return resolveStubResponse(next, state);
}

export function createStubPlayback(state: AgentStubState) {
  return {
    state,
    take(agentName: string) {
      return takeAgentStubResponse(agentName, state);
    },
    remaining(agentName: string) {
      return state.agents[agentName]?.length ?? 0;
    },
  };
}
