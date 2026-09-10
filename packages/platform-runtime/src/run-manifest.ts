import type { RuntimeEvent } from "./events.js";
import type { TaskGraph } from "./task-graph.js";
import type { WorkflowPlan } from "./workflow-plan.js";

export type RunManifest = {
  schemaVersion: "v1";
  taskOrder: string[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  stopReason: string | null;
  eventCount: number;
};

export function createRunManifest(input: {
  plan: WorkflowPlan;
  graph: TaskGraph;
  events: RuntimeEvent[];
  stopReason: string | null;
}): RunManifest {
  const completedTaskIds = input.plan.executionOrder.filter(
    (taskId) => input.graph.tasks[taskId]?.status === "completed",
  );
  const failedTaskIds = input.plan.executionOrder.filter(
    (taskId) => input.graph.tasks[taskId]?.status === "failed",
  );

  return {
    schemaVersion: "v1",
    taskOrder: [...input.plan.executionOrder],
    completedTaskIds,
    failedTaskIds,
    stopReason: input.stopReason,
    eventCount: input.events.length,
  };
}
