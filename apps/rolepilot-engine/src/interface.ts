import path from "node:path";

import { createResumeGoalInterfacePlan } from "./plan.js";
import { runResumeVerticalSlice } from "./vertical-slice.js";
import type {
  ResumeAppStatusEvent,
  ResumeGoalInterfaceInput,
  ResumeGoalInterfaceOutput,
  ResumeGoalInterfaceWriter,
  ResumeVerticalSliceInput,
} from "./types.js";

function defaultInterfaceWriter(): ResumeGoalInterfaceWriter {
  return {
    writeLine(line) {
      process.stdout.write(`${line}\n`);
    },
  };
}

function formatInterfaceStatus(event: ResumeAppStatusEvent) {
  switch (event.type) {
    case "plan-created":
      return `[CEO] accepted goal for run ${event.runId}, planned steps: ${event.steps.map((step) => `${step.id}->${step.agent}`).join(", ")}`;
    case "task-started":
      return `[CEO] ${event.agent} started ${event.stepId}`;
    case "task-completed":
      return `[CEO] ${event.agent} completed ${event.stepId}`;
    case "task-failed":
      return `[CEO] ${event.agent} failed ${event.stepId}, ${event.detail}`;
    case "task-progress":
      return `[CEO] ${event.agent} progress ${event.stepId}, ${event.detail}`;
    case "artifact-created":
      return `[CEO] artifact ready, ${event.artifact.kind}, ${event.artifact.path}`;
    case "run-completed":
      return `[CEO] run ${event.runId} completed, stopReason=${event.stopReason ?? "none"}, reviewRounds=${event.reviewRoundsUsed}`;
    case "run-cancelled":
      return `[CEO] run ${event.runId} cancelled, reason=${event.reason}`;
  }
}

function formatMachineReference(
  prefix: string,
  value: Record<string, unknown>,
) {
  return `${prefix}\t${JSON.stringify(value)}`;
}

export async function runResumeGoalInterface(
  input: ResumeGoalInterfaceInput,
  writer: ResumeGoalInterfaceWriter = defaultInterfaceWriter(),
): Promise<ResumeGoalInterfaceOutput> {
  const plan = createResumeGoalInterfacePlan(input);
  const proxiedInput: ResumeVerticalSliceInput = {
    ...input,
    onStatus(event) {
      writer.writeLine(formatInterfaceStatus(event));
      if (event.type === "artifact-created") {
        writer.writeLine(
          formatMachineReference("ARTIFACT_REF", {
            runId: event.runId,
            kind: event.artifact.kind,
            stage: event.artifact.stage,
            path: event.artifact.path,
            generator: event.artifact.generator,
          }),
        );
      }
      if (event.type === "run-completed" || event.type === "run-cancelled") {
        writer.writeLine(
          formatMachineReference("MANIFEST_REF", {
            runId: event.runId,
            path: path
              .relative(input.rootDir, event.manifestPath)
              .replaceAll("\\", "/"),
            reviewRoundsUsed: event.reviewRoundsUsed,
            stopReason:
              event.type === "run-completed" ? event.stopReason : "cancelled",
          }),
        );
      }
      input.onStatus?.(event);
    },
  };

  const result = await runResumeVerticalSlice(proxiedInput);
  if (result.finalResumePath) {
    writer.writeLine(
      `[CEO] final resume: ${path.relative(input.rootDir, result.finalResumePath).replaceAll("\\", "/")}`,
    );
  } else {
    writer.writeLine(
      `[CEO] final resume unavailable, stopReason=${result.stopReason ?? "none"}`,
    );
  }

  return {
    result,
    plan,
  };
}
