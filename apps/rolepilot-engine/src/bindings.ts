import type { BackendProvider } from "platform-adapters";

import {
  RESUME_APP_BOUNDARY,
  type ResumeAgentBinding,
  type ResumeAgentBindings,
  type ResumeAgentName,
} from "./types.js";

type AgentConfigSource = { tool?: string; model?: string };

const BACKEND_PROVIDERS = [
  "claude",
  "opencode",
  "codex",
  "openai-chat",
  "anthropic-api",
] as const;

function isBackendProvider(value: unknown): value is BackendProvider {
  return (
    typeof value === "string" &&
    BACKEND_PROVIDERS.some((provider) => provider === value)
  );
}

function resolveBackendProvider(
  agent: ResumeAgentName,
  value: unknown,
): BackendProvider {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing backend provider for agent "${agent}".`);
  }

  if (!isBackendProvider(value)) {
    throw new Error(
      `Invalid backend provider for agent "${agent}": ${value}. Expected one of ${BACKEND_PROVIDERS.join(", ")}.`,
    );
  }

  return value;
}

function createAgentBinding(
  agent: ResumeAgentName,
  config: Record<string, AgentConfigSource>,
  overrides: Partial<Record<ResumeAgentName, Partial<ResumeAgentBinding>>>,
): ResumeAgentBinding {
  const source = config[agent] ?? {};
  return {
    provider: resolveBackendProvider(agent, source.tool),
    mode: "live",
    model: source.model,
    ...overrides[agent],
  };
}

export function createResumeAppWorkspaceSummary() {
  return {
    app: RESUME_APP_BOUNDARY.packageName,
    mode: RESUME_APP_BOUNDARY.executionModel,
    boundaries: [
      "platform-adapters",
      "platform-runtime",
      "platform-state",
      "platform-policy",
      "platform-testkit",
    ],
    workflow: RESUME_APP_BOUNDARY.workflow,
  } as const;
}

export function createResumeAgentBindings(
  config: Record<string, AgentConfigSource>,
  overrides: Partial<Record<ResumeAgentName, Partial<ResumeAgentBinding>>> = {},
): ResumeAgentBindings {
  const bindings = {
    miner: createAgentBinding("miner", config, overrides),
    writer: createAgentBinding("writer", config, overrides),
    reviewer: createAgentBinding("reviewer", config, overrides),
    interviewer: createAgentBinding("interviewer", config, overrides),
  };
  const writingModel = bindings.miner.model ?? bindings.writer.model;
  return {
    ...bindings,
    miner: { ...bindings.miner, model: writingModel },
    writer: { ...bindings.writer, model: writingModel },
  };
}
