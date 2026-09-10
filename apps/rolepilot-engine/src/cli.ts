#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ResumeAgentBinding,
  type ResumeAgentBindings,
  runResumeGoalInterface,
  type ResumeGoalInterfaceInput,
  type ResumeTarget,
} from "./index.js";
import { isPlainObject, parseJsonObject } from "./shared.js";

type CliArgs = {
  goal?: string;
  company?: string;
  title?: string;
  rootDir?: string;
  runId?: string;
  configPath?: string;
  jdFile?: string;
  resumeFromCheckpoint?: boolean;
  userEvidenceText?: string;
};

type ResumeInterfaceConfigFile = Partial<ResumeGoalInterfaceInput> & {
  company?: ResumeTarget;
};

const CONFIG_ALLOWED_KEYS = new Set([
  "agentBindings",
  "company",
  "createdAt",
  "env",
  "goal",
  "hasTimelineContext",
  "importedResumeText",
  "includeInterview",
  "jdText",
  "maxOptimizationActions",
  "maxReviewRounds",
  "reviewReplanBudget",
  "resumeFromCheckpoint",
  "rootDir",
  "runId",
  "timelineText",
  "userEvidenceText",
]);

const BACKEND_PROVIDERS = [
  "claude",
  "opencode",
  "codex",
  "openai-chat",
  "anthropic-api",
] as const;
const BACKEND_MODES = ["live", "stub", "replay"] as const;
const RESUME_AGENTS = ["miner", "writer", "reviewer", "interviewer"] as const;

function isBackendProvider(
  value: unknown,
): value is ResumeAgentBinding["provider"] {
  return (
    typeof value === "string" &&
    BACKEND_PROVIDERS.some((entry) => entry === value)
  );
}

function isBackendMode(
  value: unknown,
): value is NonNullable<ResumeAgentBinding["mode"]> {
  return (
    typeof value === "string" && BACKEND_MODES.some((entry) => entry === value)
  );
}

function validateStringField(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} in --config JSON must be a string.`);
  }
  return value;
}

function validateBooleanField(
  value: unknown,
  fieldName: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} in --config JSON must be a boolean.`);
  }
  return value;
}

function validateNumberField(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${fieldName} in --config JSON must be a number.`);
  }
  return value;
}

function validateStringArrayField(
  value: unknown,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      `${fieldName} in --config JSON must be an array of strings.`,
    );
  }
  return [...value];
}

function validateEnvField(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error("env in --config JSON must be an object of string values.");
  }

  const env: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`env.${key} in --config JSON must be a string.`);
    }
    env[key] = entry;
  }
  return env;
}

function validateCompanyField(value: unknown): ResumeTarget | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error("company in --config JSON must be an object.");
  }

  return { ...value };
}

function validateReplayEntriesField(value: unknown, agent: string) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `agentBindings.${agent}.replayEntries in --config JSON must be an array.`,
    );
  }
  return [...value];
}

function validateAgentBinding(
  agent: (typeof RESUME_AGENTS)[number],
  value: unknown,
): ResumeAgentBinding {
  if (!isPlainObject(value)) {
    throw new Error(
      `agentBindings.${agent} in --config JSON must be an object.`,
    );
  }

  const provider = value.provider;
  if (!isBackendProvider(provider)) {
    throw new Error(
      `agentBindings.${agent}.provider in --config JSON must be one of ${BACKEND_PROVIDERS.join(", ")}.`,
    );
  }

  const mode = value.mode;
  if (mode !== undefined && !isBackendMode(mode)) {
    throw new Error(
      `agentBindings.${agent}.mode in --config JSON must be one of ${BACKEND_MODES.join(", ")}.`,
    );
  }

  const binding: ResumeAgentBinding = {
    provider,
  };

  if (mode !== undefined) {
    binding.mode = mode;
  }

  const model = validateStringField(
    value.model,
    `agentBindings.${agent}.model`,
  );
  if (model !== undefined) {
    binding.model = model;
  }

  const temperature = validateNumberField(
    value.temperature,
    `agentBindings.${agent}.temperature`,
  );
  if (temperature !== undefined) {
    binding.temperature = temperature;
  }

  const maxTokens = validateNumberField(
    value.maxTokens,
    `agentBindings.${agent}.maxTokens`,
  );
  if (maxTokens !== undefined) {
    binding.maxTokens = maxTokens;
  }

  const extraArgs = validateStringArrayField(
    value.extraArgs,
    `agentBindings.${agent}.extraArgs`,
  );
  if (extraArgs !== undefined) {
    binding.extraArgs = extraArgs;
  }

  const replayEntries = validateReplayEntriesField(value.replayEntries, agent);
  if (replayEntries !== undefined) {
    binding.replayEntries = replayEntries;
  }

  return binding;
}

function validateAgentBindingsField(
  value: unknown,
): ResumeAgentBindings | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error("agentBindings in --config JSON must be an object.");
  }

  return {
    miner: validateAgentBinding("miner", value.miner),
    writer: validateAgentBinding("writer", value.writer),
    reviewer: validateAgentBinding("reviewer", value.reviewer),
    interviewer: validateAgentBinding("interviewer", value.interviewer),
  };
}

function validateConfigFile(value: unknown): ResumeInterfaceConfigFile {
  if (!isPlainObject(value)) {
    throw new Error("--config JSON must be an object.");
  }

  for (const key of Object.keys(value)) {
    if (!CONFIG_ALLOWED_KEYS.has(key)) {
      throw new Error(`Unsupported key in --config JSON: ${key}.`);
    }
  }

  const config: ResumeInterfaceConfigFile = {};

  const rootDir = validateStringField(value.rootDir, "rootDir");
  if (rootDir !== undefined) {
    config.rootDir = rootDir;
  }

  const runId = validateStringField(value.runId, "runId");
  if (runId !== undefined) {
    config.runId = runId;
  }

  const goal = validateStringField(value.goal, "goal");
  if (goal !== undefined) {
    config.goal = goal;
  }

  const createdAt = validateStringField(value.createdAt, "createdAt");
  if (createdAt !== undefined) {
    config.createdAt = createdAt;
  }

  const company = validateCompanyField(value.company);
  if (company !== undefined) {
    config.company = company;
  }

  const agentBindings = validateAgentBindingsField(value.agentBindings);
  if (agentBindings !== undefined) {
    config.agentBindings = agentBindings;
  }

  const hasTimelineContext = validateBooleanField(
    value.hasTimelineContext,
    "hasTimelineContext",
  );
  if (hasTimelineContext !== undefined) {
    config.hasTimelineContext = hasTimelineContext;
  }

  const includeInterview = validateBooleanField(
    value.includeInterview,
    "includeInterview",
  );
  if (includeInterview !== undefined) {
    config.includeInterview = includeInterview;
  }

  const reviewReplanBudget = validateNumberField(
    value.reviewReplanBudget,
    "reviewReplanBudget",
  );
  if (reviewReplanBudget !== undefined) {
    config.reviewReplanBudget = reviewReplanBudget;
  }

  const maxReviewRounds = validateNumberField(
    value.maxReviewRounds,
    "maxReviewRounds",
  );
  if (maxReviewRounds !== undefined) {
    config.maxReviewRounds = maxReviewRounds;
  }

  const maxOptimizationActions = validateNumberField(
    value.maxOptimizationActions,
    "maxOptimizationActions",
  );
  if (maxOptimizationActions !== undefined) {
    if (
      !Number.isInteger(maxOptimizationActions) ||
      maxOptimizationActions < 0
    ) {
      throw new Error(
        "maxOptimizationActions in --config JSON must be a non-negative integer.",
      );
    }
    config.maxOptimizationActions = maxOptimizationActions;
  }

  const importedResumeText = validateStringField(
    value.importedResumeText,
    "importedResumeText",
  );
  if (importedResumeText !== undefined) {
    config.importedResumeText = importedResumeText;
  }

  const timelineText = validateStringField(value.timelineText, "timelineText");
  if (timelineText !== undefined) {
    config.timelineText = timelineText;
  }

  const jdText = validateStringField(value.jdText, "jdText");
  if (jdText !== undefined) {
    config.jdText = jdText;
  }

  const resumeFromCheckpoint = validateBooleanField(
    value.resumeFromCheckpoint,
    "resumeFromCheckpoint",
  );
  if (resumeFromCheckpoint !== undefined) {
    config.resumeFromCheckpoint = resumeFromCheckpoint;
  }

  const userEvidenceText = validateStringField(
    value.userEvidenceText,
    "userEvidenceText",
  );
  if (userEvidenceText !== undefined) {
    config.userEvidenceText = userEvidenceText;
  }

  const env = validateEnvField(value.env);
  if (env !== undefined) {
    config.env = env;
  }

  return config;
}

function readConfigFile(configPath?: string) {
  if (!configPath) {
    return {} satisfies ResumeInterfaceConfigFile;
  }

  const absolutePath = path.resolve(process.cwd(), configPath);
  return validateConfigFile(
    parseJsonObject(fs.readFileSync(absolutePath, "utf8"), "--config JSON"),
  );
}

function createRunId() {
  return `resume-interface-${Date.now()}`;
}

function parseArgs(argv: string[]) {
  const parsed: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--goal":
        parsed.goal = next;
        index += 1;
        break;
      case "--company":
        parsed.company = next;
        index += 1;
        break;
      case "--title":
        parsed.title = next;
        index += 1;
        break;
      case "--root-dir":
        parsed.rootDir = next;
        index += 1;
        break;
      case "--run-id":
        parsed.runId = next;
        index += 1;
        break;
      case "--config":
        parsed.configPath = next;
        index += 1;
        break;
      case "--jd-file":
        parsed.jdFile = next;
        index += 1;
        break;
      case "--resume-from-checkpoint":
        parsed.resumeFromCheckpoint = true;
        break;
      case "--user-evidence":
        parsed.userEvidenceText = next;
        index += 1;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          [
            "Usage: rolepilot-engine [options]",
            "",
            "Options:",
            "  --goal <string>      Job application goal (required)",
            "  --company <string>   Target company name (required)",
            "  --title <string>     Target job title",
            "  --config <path>      JSON configuration file path",
            "  --jd-file <path>     Job description text file path",
            "  --resume-from-checkpoint  Resume a blocked run with user evidence",
            "  --user-evidence <text>    Verified supplemental evidence for resume",
            "  --root-dir <path>    Output root directory",
            "  --run-id <string>    Run identifier",
            "  --help, -h           Show this help message",
            "",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function buildInput(argv: string[]) {
  const args = parseArgs(argv);
  const config = readConfigFile(args.configPath);
  const rootDir = path.resolve(
    process.cwd(),
    args.rootDir ?? config.rootDir ?? process.cwd(),
  );
  const company: ResumeTarget = {
    ...(config.company ?? {}),
  };

  if (args.company) {
    company.company = args.company;
  }
  if (args.title) {
    company.title = args.title;
  }

  if (
    typeof company.company !== "string" ||
    company.company.trim().length === 0
  ) {
    throw new Error("Missing required --company value.");
  }
  if (
    typeof (args.goal ?? config.goal) !== "string" ||
    (args.goal ?? config.goal)?.trim().length === 0
  ) {
    throw new Error("Missing required --goal value.");
  }
  if (!config.agentBindings) {
    throw new Error("Missing agentBindings in --config JSON.");
  }

  const jdText = args.jdFile
    ? fs.readFileSync(path.resolve(process.cwd(), args.jdFile), "utf8")
    : config.jdText;

  return {
    ...config,
    rootDir,
    runId: args.runId ?? config.runId ?? createRunId(),
    goal: args.goal ?? config.goal,
    company,
    agentBindings: config.agentBindings,
    resumeFromCheckpoint:
      args.resumeFromCheckpoint ?? config.resumeFromCheckpoint,
    userEvidenceText: args.userEvidenceText ?? config.userEvidenceText,
    ...(jdText !== undefined ? { jdText } : {}),
  } satisfies ResumeGoalInterfaceInput;
}

function isRunCancelledError(error: unknown) {
  return error instanceof Error && error.message === "Run cancelled by user.";
}

export async function runResumeAppCli(
  argv = process.argv.slice(2),
  options: {
    signal?: AbortSignal;
  } = {},
) {
  const input = buildInput(argv);
  return runResumeGoalInterface({
    ...input,
    signal: options.signal,
    onStatus: input.onStatus ?? ((event) => {
      switch (event.type) {
        case "task-started":
          process.stderr.write(`[status] ${event.agent} started ${event.stepId}\n`);
          break;
        case "task-completed":
          process.stderr.write(`[status] ${event.agent} completed ${event.stepId}\n`);
          break;
        case "task-failed":
          process.stderr.write(`[status] ${event.agent} failed ${event.stepId}: ${event.detail}\n`);
          break;
        case "task-progress":
          process.stderr.write(`[status] ${event.agent} progress ${event.stepId}: ${event.detail}\n`);
          break;
        case "run-cancelled":
          process.stderr.write(`[status] run ${event.runId} cancelled: ${event.reason}\n`);
          break;
      }
    }),
  });
}

async function main() {
  const abortController = new AbortController();
  let cancelAttempts = 0;
  const handleSignal = (signal: NodeJS.Signals) => {
    cancelAttempts += 1;
    if (cancelAttempts === 1) {
      process.stderr.write(
        `[CEO] cancellation requested via ${signal}, stopping active provider...\n`,
      );
      abortController.abort(new Error("Run cancelled by user."));
      return;
    }

    process.stderr.write(
      `[CEO] forcing exit after repeated ${signal} while cancellation is in progress.\n`,
    );
    process.exit(130);
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    await runResumeAppCli(process.argv.slice(2), {
      signal: abortController.signal,
    });
  } catch (error) {
    if (isRunCancelledError(error)) {
      process.stderr.write("[CEO] interface cancelled, Run cancelled by user.\n");
      process.exitCode = 130;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[CEO] interface error, ${message}\n`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const currentFilePath = fileURLToPath(import.meta.url);

if (invokedPath === currentFilePath) {
  void main();
}
