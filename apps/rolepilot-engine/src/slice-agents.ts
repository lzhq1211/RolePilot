import type {
  NormalizedBackendRequest,
  ReplayResponseEntry,
} from "platform-adapters";
import { createTelemetryEvent, type WorkflowTask } from "platform-runtime";
import type { ResumePlanStepId } from "platform-policy";

import { assertNonEmptyString, isJsonSyntaxError, stepIdToAgent, toJsonText } from "./shared.js";
import { emitStatus, registerArtifact } from "./slice-artifacts.js";
import type { AgentPrompt } from "./slice-step-prompts.js";
import type { ResumeSliceContext } from "./vertical-slice-types.js";

type TaskGraph = {
  tasks: Record<string, { status?: string; error?: string }>;
};

type AgentProgressEvent = {
  requestId: string;
  stage: string;
  detail: string;
  elapsedMs: number;
};

export function cloneReplayEntries(entries: ReplayResponseEntry[] | undefined) {
  return Array.isArray(entries) ? [...entries] : [];
}

export function createAgentQueues(
  bindings: ResumeSliceContext["agentBindings"],
) {
  return {
    miner: cloneReplayEntries(bindings.miner.replayEntries),
    writer: cloneReplayEntries(bindings.writer.replayEntries),
    reviewer: cloneReplayEntries(bindings.reviewer.replayEntries),
    interviewer: cloneReplayEntries(bindings.interviewer.replayEntries),
  };
}

function nextReplayEntry(
  context: ResumeSliceContext,
  agent: keyof ResumeSliceContext["agentQueues"],
) {
  const queue = context.agentQueues[agent];
  const next = queue.shift();
  if (next === undefined) {
    throw new Error(`No replay entry remaining for agent "${agent}".`);
  }
  return next;
}

function createAgentRequest(
  context: ResumeSliceContext,
  agent: keyof ResumeSliceContext["agentQueues"],
  action: string,
  prompt: string | AgentPrompt,
  stepId: ResumePlanStepId,
): NormalizedBackendRequest {
  const binding = context.agentBindings[agent];
  const mode = binding.mode ?? "live";
  const input = typeof prompt === "string" ? prompt : prompt.input;
  const systemPrompt =
    typeof prompt === "string" ? undefined : prompt.systemPrompt;
  const request: NormalizedBackendRequest & {
    signal?: AbortSignal;
    onProgress?: (event: AgentProgressEvent) => void;
  } = {
    requestId: `${context.input.runId}:${agent}:${action}:${String(
      context.state.telemetrySequence,
    ).padStart(4, "0")}`,
    provider: binding.provider,
    mode,
    input,
    cwd: context.input.rootDir,
    env: { ...context.input.env, ...binding.env },
    model: binding.model,
    temperature: binding.temperature,
    maxTokens: binding.maxTokens,
    extraArgs: binding.extraArgs,
    signal: context.input.signal,
    onProgress(event: AgentProgressEvent) {
      emitStatus(context, {
        type: "task-progress",
        runId: context.input.runId,
        stepId,
        agent,
        detail: event.detail,
        stage: event.stage,
        requestId: event.requestId,
        elapsedMs: event.elapsedMs,
      });
    },
    metadata: {
      agent,
      action,
      ...(systemPrompt ? { systemPrompt } : {}),
    },
  };

  const usesInlineOfflineEntry =
    mode === "replay" || (mode === "stub" && Array.isArray(binding.replayEntries));

  if (usesInlineOfflineEntry) {
    request.replay = {
      entries: [nextReplayEntry(context, agent)],
      cwd: context.input.rootDir,
    };
  }

  return request;
}

function elapsedMs(context: ResumeSliceContext) {
  return Date.now() - context.startedAt;
}

export function executeAgent(
  context: ResumeSliceContext,
  agent: keyof ResumeSliceContext["agentQueues"],
  stepId: ResumePlanStepId,
  action: string,
  input: string | AgentPrompt,
  detail: string,
  options: {
    onRawResponse?: (record: { path: string; absolutePath: string }) => void;
  } = {},
) {
  const binding = context.agentBindings[agent];
  const event = createTelemetryEvent({
    runId: context.input.runId,
    sequence: context.state.telemetrySequence,
    elapsedMs: elapsedMs(context),
    agent,
    backend: binding.provider,
    action,
    detail,
  });
  context.state.telemetrySequence += 1;
  context.workspace.recordTelemetry(event);

  return context.registry
    .execute(createAgentRequest(context, agent, action, input, stepId))
    .then((result) => {
      const doneEvent = createTelemetryEvent({
        runId: context.input.runId,
        sequence: context.state.telemetrySequence,
        elapsedMs: elapsedMs(context),
        agent,
        backend: binding.provider,
        action: `${action} done`,
        detail: `completed ${action}`,
      });
      context.state.telemetrySequence += 1;
      context.workspace.recordTelemetry(doneEvent);
      const outputText = assertNonEmptyString(
        result.outputText,
        `${agent} did not return output for ${action}.`,
      );
      // Preserve the provider response before any stage parser can reject it.
      // This is a supporting diagnostic, never a resume or delivery artifact.
      const rawResponse = registerArtifact(context, {
        kind: "log",
        fileName: `${agent}.${action.replace(/[^a-z0-9_-]+/gi, "-")}.raw-response-${context.state.telemetrySequence}.txt`,
        generator: agent,
        stage: "supporting",
      }, outputText);
      options.onRawResponse?.(rawResponse);
      return outputText;
    });
}

export type ContractRetryContext = { parseError: string; invalidResponse: string };

/** Retry only a received response that fails its output contract, never a provider failure. */
export async function executeAgentWithContract<T>(
  context: ResumeSliceContext,
  options: {
    agent: keyof ResumeSliceContext["agentQueues"];
    stepId: ResumePlanStepId;
    action: string;
    detail: string;
    prompt: (retry: ContractRetryContext | undefined) => AgentPrompt;
    parse: (response: string) => T;
    auditFileName: string;
    auditMetadata?: Record<string, unknown>;
    reasonPrefix: string;
    retryEnabled?: boolean;
    isSyntaxError?: (error: unknown) => boolean;
    syntaxKind?: "json" | "yaml";
  },
): Promise<T> {
  const live = (context.agentBindings[options.agent].mode ?? "live") === "live";
  const maxAttempts = live && options.retryEnabled !== false ? 2 : 1;
  let retry: ContractRetryContext | undefined;
  let audit: Record<string, unknown> | undefined;
  let action = options.action;
  const saveAudit = (payload: Record<string, unknown>, intent = false) => registerArtifact(context, {
    kind: "log",
    fileName: intent ? options.auditFileName.replace(/\.json$/, ".intent.json") : options.auditFileName,
    generator: "rolepilot-engine",
    stage: "supporting",
  }, toJsonText(payload));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response = "";
    let responseReceived = false;
    let responsePath: string | null = null;
    let parsed: T;
    try {
      response = await executeAgent(context, options.agent, options.stepId, action, options.prompt(retry), options.detail, {
        onRawResponse: (record) => { responsePath = record.path; },
      });
      responseReceived = true;
      parsed = options.parse(response);
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      if (!responseReceived || context.input.signal?.aborted || attempt >= maxAttempts) {
        if (audit) saveAudit({ ...audit, retryResponsePath: responsePath, result: "failed", failureReason });
        throw error;
      }
      const kind = (options.isSyntaxError ?? isJsonSyntaxError)(error) ? (options.syntaxKind ?? "json") : "contract";
      retry = { parseError: failureReason, invalidResponse: response };
      action = `${options.action}-${kind}-retry-1`;
      audit = {
        stage: options.stepId,
        ...options.auditMetadata,
        reason: `${options.reasonPrefix}-${kind === "contract" ? "contract" : `${kind}-syntax`}-retry`,
        originalAction: options.action,
        retryAction: action,
        attempt: 1,
        maxAttempts: 2,
        parseError: failureReason,
        invalidResponsePath: responsePath,
      };
      saveAudit({ ...audit, result: "pending" }, true);
      continue;
    }
    if (audit) saveAudit({ ...audit, retryResponsePath: responsePath, result: "recovered" });
    return parsed;
  }
  throw new Error("Agent contract retry did not produce a validated response.");
}

export function isResumePlanStepId(value: string): value is ResumePlanStepId {
  return (
    value === "mine" ||
    value === "jd-analysis" ||
    value === "preflight" ||
    value === "write" ||
    value === "review" ||
    value === "interview"
  );
}

export function assertResumePlanStepId(value: string): ResumePlanStepId {
  if (!isResumePlanStepId(value)) {
    throw new Error(`Unsupported workflow task: ${value}`);
  }
  return value;
}

function isTaskGraph(value: unknown): value is TaskGraph {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const tasks = Reflect.get(value, "tasks");
  return Boolean(tasks && typeof tasks === "object" && !Array.isArray(tasks));
}

export function getFailedTaskMessage(graph: unknown, taskIds: string[]) {
  if (!isTaskGraph(graph)) {
    throw new Error("Workflow runtime returned an invalid task graph.");
  }

  const failedTaskId = taskIds.find(
    (taskId) => graph.tasks[taskId]?.status === "failed",
  );
  const failedMessage = failedTaskId ? graph.tasks[failedTaskId]?.error : null;
  return { failedTaskId, failedMessage };
}

export function resolveTaskAgent(task: WorkflowTask) {
  const stepId = assertResumePlanStepId(task.id);
  return {
    stepId,
    agent: stepIdToAgent(stepId),
  };
}
