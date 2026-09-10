import fs from "node:fs";
import path from "node:path";

import {
  ARTIFACT_KINDS,
  LOG_EVENT_LEVELS,
  validateArtifactManifest,
  validateLogEvent,
} from "platform-contracts";

export const PLATFORM_RUNTIME_BOUNDARY = {
  packageName: "platform-runtime",
  layer: "runtime",
  determinism: "file-backed-workspace",
  executionModel: "local-first",
  workspace: "file-backed",
} as const;

export const defaultWorkspaceLayout = Object.freeze({
  resumesDraftsDir: "resumes/drafts",
  resumesFinalDir: "resumes/gem",
  timelinesDir: "timelines/gem",
  interviewsDir: "interviews/gem",
  cheatsheetsDir: "cheatsheets",
  logsDir: "logs",
}) satisfies WorkspaceLayout;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type LogEventLevel = (typeof LOG_EVENT_LEVELS)[number];
export type ArtifactStage = "draft" | "final" | "deliverable" | "supporting";

export type WorkspaceLayout = {
  resumesDraftsDir: string;
  resumesFinalDir: string;
  timelinesDir: string;
  interviewsDir: string;
  cheatsheetsDir: string;
  logsDir: string;
};

export type ArtifactSpec = {
  kind: ArtifactKind;
  fileName: string;
  generator: string;
  stage?: ArtifactStage;
};

export type ArtifactRecord = ReturnType<typeof createArtifactRecord>;

export type ArtifactManifest = {
  schemaVersion: "v1";
  runId: string;
  createdAt: string;
  rootDir: string;
  layout: WorkspaceLayout;
  artifacts: ArtifactRecord[];
};

export type TelemetryEventInput = {
  runId: string;
  sequence: number;
  elapsedMs: number;
  agent: string;
  backend?: string;
  action: string;
  detail: string;
  level?: LogEventLevel;
  occurredAt?: string;
};

export type TelemetryEvent = ReturnType<typeof createTelemetryEvent>;

type TelemetrySnapshot = {
  events: TelemetryEvent[];
  lines: string[];
  streamPath: string;
  logPath: string;
};

type FileWorkspaceOptions = {
  rootDir: string;
  runId: string;
  layout?: Partial<WorkspaceLayout>;
  createdAt?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}

function toPosixPath(value: string) {
  return value.replaceAll("\\", "/");
}

function assertRelativeDirectory(
  value: string,
  fieldName: keyof WorkspaceLayout,
) {
  const normalized = toPosixPath(
    assertNonEmptyString(value, `Workspace layout field "${fieldName}"`),
  );
  if (normalized.startsWith("/") || path.posix.isAbsolute(normalized)) {
    throw new Error(
      `Workspace layout field "${fieldName}" must be relative to the workspace root.`,
    );
  }

  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(
      `Workspace layout field "${fieldName}" must stay within the workspace root.`,
    );
  }

  return segments.join("/");
}

function assertFileName(fileName: string) {
  const normalized = assertNonEmptyString(fileName, "Artifact fileName");
  if (
    normalized !== path.posix.basename(normalized) ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new Error("Artifact fileName must be a simple file name.");
  }

  return normalized;
}

function assertRunId(runId: string) {
  const normalized = assertNonEmptyString(runId, "runId");
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new Error(
      "runId must contain only letters, numbers, dots, underscores, or dashes.",
    );
  }

  return normalized;
}

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "artifact"
  );
}

function determineArtifactStage(
  kind: ArtifactKind,
  stage?: ArtifactStage,
): ArtifactStage {
  if (stage) {
    return stage;
  }

  switch (kind) {
    case "resume":
    case "jd-analysis":
    case "review-report":
      return "draft";
    case "timeline":
    case "log":
    case "preflight":
    case "supplemental-evidence":
    case "questions":
    case "unsupported":
      return "supporting";
    default:
      return "deliverable";
  }
}

function resolveArtifactDirectoryKey(
  kind: ArtifactKind,
  stage: ArtifactStage,
): keyof WorkspaceLayout {
  if (kind === "resume") {
    return stage === "final" ? "resumesFinalDir" : "resumesDraftsDir";
  }

  switch (kind) {
    case "jd-analysis":
    case "review-report":
    case "preflight":
    case "supplemental-evidence":
    case "questions":
    case "unsupported":
      return "resumesDraftsDir";
    case "timeline":
      return "timelinesDir";
    case "interview":
      return "interviewsDir";
    case "cheatsheet":
      return "cheatsheetsDir";
    case "log":
      return "logsDir";
    default:
      return "resumesDraftsDir";
  }
}

function getTelemetryPaths(
  rootDir: string,
  layout: WorkspaceLayout,
  runId: string,
) {
  const relativeDir = path.posix.join(layout.logsDir, runId);
  const absoluteDir = path.join(rootDir, ...relativeDir.split("/"));
  return {
    relativeDir,
    absoluteDir,
    streamRelativePath: path.posix.join(relativeDir, "telemetry.jsonl"),
    streamPath: path.join(absoluteDir, "telemetry.jsonl"),
    logRelativePath: path.posix.join(relativeDir, `orchestrate-${runId}.log`),
    logPath: path.join(absoluteDir, `orchestrate-${runId}.log`),
  };
}

function renderTelemetryLine(event: {
  elapsedMs: number;
  agent: string;
  backend: string;
  action: string;
  detail: string;
}) {
  return `[${(event.elapsedMs / 1000).toFixed(1)}s] [${event.agent}→${event.backend}] ${event.action}: ${event.detail}`;
}

function formatValidationErrors(validation: { errors?: string[] }) {
  return validation.errors?.join(", ") || "unknown validation error";
}

function createCurrentIsoTimestamp() {
  return new Date().toISOString();
}

function parseJsonObject(text: string, label: string) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} contains invalid JSON: ${reason}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return parsed;
}

function getRequiredTelemetryString(
  event: Record<string, unknown>,
  key: string,
  lineNumber: number,
) {
  return assertNonEmptyString(
    Reflect.get(event, key),
    `Telemetry line ${lineNumber} field \"${key}\"`,
  );
}

function getRequiredTelemetryNumber(
  event: Record<string, unknown>,
  key: string,
  lineNumber: number,
) {
  const value = Reflect.get(event, key);
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new Error(
      `Telemetry line ${lineNumber} field \"${key}\" must be a finite number.`,
    );
  }

  return normalized;
}

function getTelemetryLevel(
  event: Record<string, unknown>,
  lineNumber: number,
): LogEventLevel {
  const levelValue = Reflect.get(event, "level");
  const level =
    levelValue === undefined
      ? "info"
      : assertNonEmptyString(
          levelValue,
          `Telemetry line ${lineNumber} field \"level\"`,
        );

  if (!LOG_EVENT_LEVELS.includes(level as LogEventLevel)) {
    throw new Error(
      `Telemetry line ${lineNumber} field \"level\" must be one of ${LOG_EVENT_LEVELS.join(", ")}.`,
    );
  }

  return level as LogEventLevel;
}

function parseTelemetryEventLine(
  line: string,
  lineNumber: number,
): TelemetryEvent {
  const event = parseJsonObject(line, `Telemetry line ${lineNumber}`);
  const backendValue = Reflect.get(event, "backend");
  const occurredAtValue = Reflect.get(event, "occurredAt");
  const normalizedEvent = {
    eventId: getRequiredTelemetryString(event, "eventId", lineNumber),
    runId: getRequiredTelemetryString(event, "runId", lineNumber),
    sequence: getRequiredTelemetryNumber(event, "sequence", lineNumber),
    elapsedMs: getRequiredTelemetryNumber(event, "elapsedMs", lineNumber),
    occurredAt:
      occurredAtValue === undefined
        ? createCurrentIsoTimestamp()
        : assertNonEmptyString(
            occurredAtValue,
            `Telemetry line ${lineNumber} field \"occurredAt\"`,
          ),
    level: getTelemetryLevel(event, lineNumber),
    agent: getRequiredTelemetryString(event, "agent", lineNumber),
    backend:
      backendValue === undefined
        ? "?"
        : assertNonEmptyString(
            backendValue,
            `Telemetry line ${lineNumber} field \"backend\"`,
          ),
    action: getRequiredTelemetryString(event, "action", lineNumber),
    detail: getRequiredTelemetryString(event, "detail", lineNumber),
  };

  const validation = validateLogEvent({
    eventId: normalizedEvent.eventId,
    agent: normalizedEvent.agent,
    action: normalizedEvent.action,
    level: normalizedEvent.level,
  });
  if (!validation.valid) {
    throw new Error(
      `Invalid telemetry line ${lineNumber}: ${formatValidationErrors(validation)}`,
    );
  }

  return normalizedEvent;
}

function createArtifactRecord(
  runId: string,
  rootDir: string,
  layout: WorkspaceLayout,
  spec: ArtifactSpec,
) {
  const stage = determineArtifactStage(spec.kind, spec.stage);
  const fileName = assertFileName(spec.fileName);
  const directoryKey = resolveArtifactDirectoryKey(spec.kind, stage);
  const baseRelativeDir = layout[directoryKey];
  const relativePath = path.posix.join(baseRelativeDir, runId, fileName);
  const absolutePath = path.join(rootDir, ...relativePath.split("/"));
  const record = {
    artifactId: `${runId}:${spec.kind}:${slugify(fileName)}`,
    runId,
    kind: spec.kind,
    stage,
    generator: assertNonEmptyString(spec.generator, "Artifact generator"),
    fileName,
    path: relativePath,
    absolutePath,
  };

  const validation = validateArtifactManifest({
    artifactId: record.artifactId,
    kind: record.kind,
    path: record.path,
  });
  if (!validation.valid) {
    throw new Error(
      `Invalid artifact manifest entry: ${formatValidationErrors(validation)}`,
    );
  }

  return record;
}

export function describePlatformRuntimeBoundary() {
  return `${PLATFORM_RUNTIME_BOUNDARY.packageName}:${PLATFORM_RUNTIME_BOUNDARY.layer}`;
}

export function createTelemetryEvent(input: TelemetryEventInput) {
  const runId = assertRunId(input.runId);
  const sequence = Number(input.sequence);
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error("Telemetry sequence must be a positive integer.");
  }

  const elapsedMs = Number(input.elapsedMs);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error("Telemetry elapsedMs must be a non-negative number.");
  }

  const event = {
    eventId: `${runId}:event:${String(sequence).padStart(4, "0")}`,
    runId,
    sequence,
    elapsedMs,
    occurredAt: input.occurredAt ?? createCurrentIsoTimestamp(),
    level: input.level ?? "info",
    agent: assertNonEmptyString(input.agent, "Telemetry agent"),
    backend: input.backend?.trim() || "?",
    action: assertNonEmptyString(input.action, "Telemetry action"),
    detail: assertNonEmptyString(input.detail, "Telemetry detail"),
  };

  const validation = validateLogEvent({
    eventId: event.eventId,
    agent: event.agent,
    action: event.action,
    level: event.level,
  });
  if (!validation.valid) {
    throw new Error(
      `Invalid telemetry event: ${formatValidationErrors(validation)}`,
    );
  }

  return event;
}

export function createFileWorkspace(options: FileWorkspaceOptions) {
  const rootDir = path.resolve(
    assertNonEmptyString(options.rootDir, "rootDir"),
  );
  const runId = assertRunId(options.runId);
  const createdAt = options.createdAt ?? createCurrentIsoTimestamp();
  const layout = Object.freeze({
    ...defaultWorkspaceLayout,
    ...Object.fromEntries(
      Object.entries(options.layout ?? {}).map(([key, value]) => [
        key,
        assertRelativeDirectory(
          assertNonEmptyString(value, `Workspace layout field \"${key}\"`),
          key as keyof WorkspaceLayout,
        ),
      ]),
    ),
  }) satisfies WorkspaceLayout;
  const telemetryPaths = getTelemetryPaths(rootDir, layout, runId);
  const artifacts = new Map<string, ArtifactRecord>();

  fs.mkdirSync(rootDir, { recursive: true });
  for (const relativeDir of Object.values(layout)) {
    fs.mkdirSync(path.join(rootDir, ...relativeDir.split("/")), {
      recursive: true,
    });
  }
  fs.mkdirSync(telemetryPaths.absoluteDir, { recursive: true });

  function registerArtifact(spec: ArtifactSpec) {
    const record = createArtifactRecord(runId, rootDir, layout, spec);
    fs.mkdirSync(path.dirname(record.absolutePath), { recursive: true });
    artifacts.set(record.artifactId, record);
    return record;
  }

  function resolveArtifactPath(spec: ArtifactSpec) {
    return createArtifactRecord(runId, rootDir, layout, spec).absolutePath;
  }

  function createArtifactManifest(): ArtifactManifest {
    return {
      schemaVersion: "v1",
      runId,
      createdAt,
      rootDir,
      layout,
      artifacts: [...artifacts.values()].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    };
  }

  function recordTelemetry(event: TelemetryEvent) {
    const validation = validateLogEvent({
      eventId: event?.eventId,
      agent: event?.agent,
      action: event?.action,
      level: event?.level,
    });
    if (!validation.valid) {
      throw new Error(
        `Invalid telemetry event: ${formatValidationErrors(validation)}`,
      );
    }

    const normalizedEvent = {
      ...event,
      backend: event.backend?.trim() || "?",
      detail: assertNonEmptyString(event.detail, "Telemetry detail"),
    };
    const line = renderTelemetryLine(normalizedEvent);
    fs.mkdirSync(telemetryPaths.absoluteDir, { recursive: true });
    fs.appendFileSync(
      telemetryPaths.streamPath,
      `${JSON.stringify(normalizedEvent)}\n`,
      "utf8",
    );
    fs.appendFileSync(telemetryPaths.logPath, `${line}\n`, "utf8");

    return normalizedEvent;
  }

  function readTelemetry(): TelemetrySnapshot {
    const streamSource = fs.existsSync(telemetryPaths.streamPath)
      ? fs.readFileSync(telemetryPaths.streamPath, "utf8").trim()
      : "";
    const logSource = fs.existsSync(telemetryPaths.logPath)
      ? fs.readFileSync(telemetryPaths.logPath, "utf8").trim()
      : "";

    return {
      events: streamSource
        ? streamSource
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line, index) => parseTelemetryEventLine(line, index + 1))
        : [],
      lines: logSource ? logSource.split(/\r?\n/).filter(Boolean) : [],
      streamPath: telemetryPaths.streamPath,
      logPath: telemetryPaths.logPath,
    };
  }

  return {
    rootDir,
    runId,
    createdAt,
    layout,
    telemetry: {
      directory: telemetryPaths.absoluteDir,
      streamPath: telemetryPaths.streamPath,
      logPath: telemetryPaths.logPath,
      streamRelativePath: telemetryPaths.streamRelativePath,
      logRelativePath: telemetryPaths.logRelativePath,
    },
    resolveArtifactPath,
    registerArtifact,
    createArtifactManifest,
    recordTelemetry,
    readTelemetry,
  };
}
