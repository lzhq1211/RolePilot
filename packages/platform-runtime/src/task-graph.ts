import type { WorkflowPlan } from "./workflow-plan.js";

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export type TaskState = {
  id: string;
  status: TaskStatus;
  output?: unknown;
  error?: string;
};

export type TaskGraph = {
  taskOrder: string[];
  tasks: Record<string, TaskState>;
};

function assertKnownTask(graph: TaskGraph, taskId: string) {
  const task = graph.tasks[taskId];
  if (!task) {
    throw new Error(`Unknown task graph task: "${taskId}".`);
  }

  return task;
}

export function createTaskGraph(plan: WorkflowPlan): TaskGraph {
  return {
    taskOrder: [...plan.executionOrder],
    tasks: Object.fromEntries(
      plan.executionOrder.map((taskId) => [
        taskId,
        {
          id: taskId,
          status: "pending" as const,
        },
      ]),
    ),
  };
}

export function restoreTaskGraph(
  snapshot: TaskGraph,
  plan: WorkflowPlan,
): TaskGraph {
  const restored = createTaskGraph(plan);
  for (const taskId of plan.executionOrder) {
    const taskState = snapshot?.tasks?.[taskId];
    if (!taskState) {
      continue;
    }
    restored.tasks[taskId] = {
      id: taskId,
      status: taskState.status,
      output: taskState.output,
      error: taskState.error,
    };
  }
  return restored;
}

export function listReadyTaskIds(plan: WorkflowPlan, graph: TaskGraph) {
  return plan.executionOrder.filter((taskId) => {
    const task = assertKnownTask(graph, taskId);
    if (task.status !== "pending") {
      return false;
    }
    return plan.tasksById[taskId].dependencies.every(
      (dependencyId) =>
        assertKnownTask(graph, dependencyId).status === "completed",
    );
  });
}

export function markTaskRunning(graph: TaskGraph, taskId: string): TaskGraph {
  const task = assertKnownTask(graph, taskId);
  if (task.status !== "pending") {
    throw new Error(
      `Task "${taskId}" cannot enter running from status "${task.status}".`,
    );
  }

  return {
    ...graph,
    tasks: {
      ...graph.tasks,
      [taskId]: {
        id: taskId,
        status: "running",
      },
    },
  };
}

export function markTaskCompleted(
  graph: TaskGraph,
  taskId: string,
  output: unknown,
): TaskGraph {
  const task = assertKnownTask(graph, taskId);
  if (task.status !== "running") {
    throw new Error(
      `Task "${taskId}" cannot complete from status "${task.status}".`,
    );
  }

  return {
    ...graph,
    tasks: {
      ...graph.tasks,
      [taskId]: {
        id: taskId,
        status: "completed",
        output,
      },
    },
  };
}

export function markTaskFailed(
  graph: TaskGraph,
  taskId: string,
  error: unknown,
): TaskGraph {
  const task = assertKnownTask(graph, taskId);
  if (task.status !== "running") {
    throw new Error(
      `Task "${taskId}" cannot fail from status "${task.status}".`,
    );
  }

  return {
    ...graph,
    tasks: {
      ...graph.tasks,
      [taskId]: {
        id: taskId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    },
  };
}

export function getTaskGraphStatusCounts(graph: TaskGraph) {
  return Object.values(graph.tasks).reduce(
    (counts, task) => {
      counts[task.status] += 1;
      return counts;
    },
    {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    },
  );
}

export function hasTaskGraphFailures(graph: TaskGraph) {
  return Object.values(graph.tasks).some((task) => task.status === "failed");
}

export function isTaskGraphComplete(graph: TaskGraph) {
  return Object.values(graph.tasks).every(
    (task) => task.status === "completed",
  );
}
