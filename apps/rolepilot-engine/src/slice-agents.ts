import type {
  NormalizedBackendRequest,
  ReplayResponseEntry,
} from "platform-adapters";
import { createTelemetryEvent, type WorkflowTask } from "platform-runtime";
import type { ResumePlanStepId } from "platform-policy";

import { assertNonEmptyString, stepIdToAgent } from "./shared.js";
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
