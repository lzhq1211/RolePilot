import {
  createCheckpointSnapshot,
  restoreCheckpointSnapshot,
  type CheckpointSnapshot,
} from "./checkpoint-runtime.js";
import { createRuntimeEvent, type RuntimeEvent } from "./events.js";
import { createRunManifest } from "./run-manifest.js";
import {
  createTaskGraph,
  hasTaskGraphFailures,
  isTaskGraphComplete,
  listReadyTaskIds,
  markTaskCompleted,
  markTaskFailed,
  markTaskRunning,
  restoreTaskGraph,
  type TaskGraph,
} from "./task-graph.js";
import type { WorkflowPlan, WorkflowTask } from "./workflow-plan.js";

export type RuntimeStopReason =
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";
export type RuntimeStopDecision =
  | boolean
  | {
      stopReason: RuntimeStopReason;
    };

export type ExecuteTaskContext<TContext> = {
  graph: TaskGraph;
  events: RuntimeEvent[];
  context: TContext;
};

export type WorkflowRuntimeOptions<TContext> = {
  plan: WorkflowPlan;
  executeTask: (
    task: WorkflowTask,
    context: ExecuteTaskContext<TContext>,
  ) => Promise<unknown> | unknown;
  context: TContext;
  checkpoint?: CheckpointSnapshot;
  shouldStopAfterTask?: (
    task: WorkflowTask,
    graph: TaskGraph,
  ) => RuntimeStopDecision;
  signal?: AbortSignal;
};

function isCancelledError(error: unknown) {
  return Boolean(
    (error instanceof Error && error.name === "AbortError") ||
      (typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "code") === "CLI_CANCELLED"),
  );
}

function resolveStopDecision(
  decision: RuntimeStopDecision | undefined,
): RuntimeStopReason | null {
  if (decision === true) {
    return null;
  }
  if (!decision) {
    return null;
  }
  return decision.stopReason;
}

export function createWorkflowRuntime<TContext>(
  options: WorkflowRuntimeOptions<TContext>,
) {
  const restored = options.checkpoint
    ? restoreCheckpointSnapshot(options.checkpoint)
    : null;

  let graph = restored
    ? restoreTaskGraph(restored.graph, options.plan)
    : createTaskGraph(options.plan);
  let events = restored ? [...restored.events] : [];
  let nextSequence = restored?.nextSequence ?? 1;
  let stopReason = restored?.stopReason ?? null;

  function emit(
    type: RuntimeEvent["type"],
    detail: Omit<RuntimeEvent, "sequence" | "type"> = {},
  ) {
    const event = createRuntimeEvent(nextSequence, type, detail);
    events = [...events, event];
    nextSequence += 1;
    return event;
  }

  function ensureStarted() {
    if (events.some((event) => event.type === "runtime-started")) {
      return;
    }
    emit("runtime-started");
  }

  async function run() {
    ensureStarted();

    while (true) {
      if (options.signal?.aborted) {
        stopReason = "cancelled";
        break;
      }
      if (isTaskGraphComplete(graph)) {
        stopReason = "completed";
        break;
      }
      if (hasTaskGraphFailures(graph)) {
        stopReason = "failed";
        break;
      }

      const nextTaskId = listReadyTaskIds(options.plan, graph)[0];
      if (!nextTaskId) {
        stopReason = hasTaskGraphFailures(graph) ? "failed" : "completed";
        break;
      }

      const task = options.plan.tasksById[nextTaskId];
      graph = markTaskRunning(graph, task.id);
      emit("task-started", { taskId: task.id });

      try {
        const output = await options.executeTask(task, {
          graph,
          events,
          context: options.context,
        });
        graph = markTaskCompleted(graph, task.id, output);
        emit("task-completed", { taskId: task.id });
      } catch (error) {
        graph = markTaskFailed(graph, task.id, error);
        emit("task-failed", { taskId: task.id });
        stopReason =
          options.signal?.aborted || isCancelledError(error)
            ? "cancelled"
            : "failed";
        break;
      }

      const stopDecision = options.shouldStopAfterTask?.(task, graph);
      const requestedStopReason = resolveStopDecision(stopDecision);
      if (requestedStopReason) {
        stopReason = requestedStopReason;
        return getState();
      }
      if (stopDecision === true) {
        return getState();
      }
    }

    if (!events.some((event) => event.type === "runtime-stopped")) {
      emit("runtime-stopped", { stopReason: stopReason ?? "completed" });
    } else if (events.at(-1)?.type !== "runtime-stopped") {
      emit("runtime-stopped", { stopReason: stopReason ?? "completed" });
    }

    return getState();
  }

  function getManifest() {
    return createRunManifest({
      plan: options.plan,
      graph,
      events,
      stopReason,
    });
  }

  function createCheckpoint() {
    return createCheckpointSnapshot({
      plan: options.plan,
      graph,
      events,
      stopReason,
    });
  }

  function getState() {
    return {
      graph,
      events,
      stopReason,
      manifest: getManifest(),
      checkpoint: createCheckpoint(),
    };
  }

  return {
    run,
    getState,
    getManifest,
    createCheckpoint,
  };
}
