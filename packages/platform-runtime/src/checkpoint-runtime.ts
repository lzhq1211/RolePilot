import type { RuntimeEvent } from "./events.js";
import { createRunManifest, type RunManifest } from "./run-manifest.js";
import type { TaskGraph } from "./task-graph.js";
import type { WorkflowPlan } from "./workflow-plan.js";

export type CheckpointSnapshot = {
  schemaVersion: "v1";
  graph: TaskGraph;
  events: RuntimeEvent[];
  stopReason: string | null;
  nextSequence: number;
  manifest: RunManifest;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertStringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
}

function assertCheckpointGraph(value: unknown) {
  if (!isPlainObject(value)) {
    throw new Error("Checkpoint snapshot graph must be an object.");
  }

  const tasks = Reflect.get(value, "tasks");
  if (!isPlainObject(tasks)) {
    throw new Error("Checkpoint snapshot graph.tasks must be an object.");
  }

  assertStringArray(
    Reflect.get(value, "taskOrder"),
    "Checkpoint snapshot graph.taskOrder",
  );
}

function assertCheckpointManifest(value: unknown) {
  if (!isPlainObject(value)) {
    throw new Error("Checkpoint snapshot manifest must be an object.");
  }

  if (Reflect.get(value, "schemaVersion") !== "v1") {
    throw new Error("Checkpoint snapshot manifest schemaVersion must be v1.");
  }

  assertStringArray(
    Reflect.get(value, "taskOrder"),
    "Checkpoint snapshot manifest.taskOrder",
  );
  assertStringArray(
    Reflect.get(value, "completedTaskIds"),
    "Checkpoint snapshot manifest.completedTaskIds",
  );
  assertStringArray(
    Reflect.get(value, "failedTaskIds"),
    "Checkpoint snapshot manifest.failedTaskIds",
  );

  const stopReason = Reflect.get(value, "stopReason");
  if (stopReason !== null && typeof stopReason !== "string") {
    throw new Error(
      "Checkpoint snapshot manifest.stopReason must be a string or null.",
    );
  }

  const eventCount = Reflect.get(value, "eventCount");
  if (
    typeof eventCount !== "number" ||
    !Number.isInteger(eventCount) ||
    eventCount < 0
  ) {
    throw new Error(
      "Checkpoint snapshot manifest.eventCount must be a non-negative integer.",
    );
  }
}

export function createCheckpointSnapshot(input: {
  plan: WorkflowPlan;
  graph: TaskGraph;
  events: RuntimeEvent[];
  stopReason: string | null;
}): CheckpointSnapshot {
  return {
    schemaVersion: "v1",
    graph: input.graph,
    events: input.events,
    stopReason: input.stopReason,
    nextSequence: input.events.length + 1,
    manifest: createRunManifest(input),
  };
}

export function restoreCheckpointSnapshot(snapshot: CheckpointSnapshot) {
  if (!isPlainObject(snapshot) || Reflect.get(snapshot, "schemaVersion") !== "v1") {
    throw new Error("Unsupported checkpoint snapshot.");
  }

  assertCheckpointGraph(Reflect.get(snapshot, "graph"));

  const events = Reflect.get(snapshot, "events");
  if (!Array.isArray(events)) {
    throw new Error("Checkpoint snapshot events must be an array.");
  }

  const stopReason = Reflect.get(snapshot, "stopReason");
  if (stopReason !== null && typeof stopReason !== "string") {
    throw new Error("Checkpoint snapshot stopReason must be a string or null.");
  }

  const nextSequence = Reflect.get(snapshot, "nextSequence");
  if (
    typeof nextSequence !== "number" ||
    !Number.isInteger(nextSequence) ||
    nextSequence < 1
  ) {
    throw new Error(
      "Checkpoint snapshot nextSequence must be a positive integer.",
    );
  }

  assertCheckpointManifest(Reflect.get(snapshot, "manifest"));

  return snapshot;
}
