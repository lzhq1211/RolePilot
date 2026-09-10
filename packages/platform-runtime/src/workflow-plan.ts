export type WorkflowTaskInput = {
  id: string;
  dependencies?: string[];
  payload?: unknown;
};

export type WorkflowTask = {
  id: string;
  dependencies: string[];
  payload?: unknown;
};

export type WorkflowPlan = {
  tasks: WorkflowTask[];
  tasksById: Record<string, WorkflowTask>;
  taskIds: string[];
  executionOrder: string[];
};

function assertTaskId(value: unknown, fieldName: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}

function normalizeDependencies(
  taskId: string,
  dependencies: string[] | undefined,
) {
  const seen = new Set<string>();
  const normalized = [...(dependencies ?? [])]
    .map((dependencyId) =>
      assertTaskId(dependencyId, `Task "${taskId}" dependency`),
    )
    .sort((left, right) => left.localeCompare(right))
    .filter((dependencyId) => {
      if (seen.has(dependencyId)) {
        return false;
      }
      seen.add(dependencyId);
      return true;
    });

  if (normalized.includes(taskId)) {
    throw new Error(`Workflow plan task "${taskId}" cannot depend on itself.`);
  }

  return normalized;
}

export function createWorkflowPlan(tasks: WorkflowTaskInput[]): WorkflowPlan {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("Workflow plan must include at least one task.");
  }

  const tasksById = new Map<string, WorkflowTask>();

  for (const input of tasks) {
    const id = assertTaskId(input?.id, "Workflow task id");
    if (tasksById.has(id)) {
      throw new Error(
        `Workflow plan task ids must be unique. Duplicate id: "${id}".`,
      );
    }

    tasksById.set(id, {
      id,
      dependencies: normalizeDependencies(id, input.dependencies),
      payload: input.payload,
    });
  }

  for (const task of tasksById.values()) {
    for (const dependencyId of task.dependencies) {
      if (!tasksById.has(dependencyId)) {
        throw new Error(
          `Workflow plan task "${task.id}" depends on unknown task "${dependencyId}".`,
        );
      }
    }
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasksById.values()) {
    inDegree.set(task.id, task.dependencies.length);
    dependents.set(task.id, []);
  }

  for (const task of tasksById.values()) {
    for (const dependencyId of task.dependencies) {
      dependents.get(dependencyId)?.push(task.id);
    }
  }

  for (const dependencyIds of dependents.values()) {
    dependencyIds.sort((left, right) => left.localeCompare(right));
  }

  const ready = [...tasksById.values()]
    .filter((task) => task.dependencies.length === 0)
    .map((task) => task.id)
    .sort((left, right) => left.localeCompare(right));
  const executionOrder: string[] = [];

  while (ready.length > 0) {
    const taskId = ready.shift();
    if (!taskId) {
      break;
    }

    executionOrder.push(taskId);
    for (const dependentId of dependents.get(taskId) ?? []) {
      const remaining = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, remaining);
      if (remaining === 0) {
        ready.push(dependentId);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  if (executionOrder.length !== tasksById.size) {
    throw new Error("Workflow plan contains a cycle.");
  }

  return {
    tasks: executionOrder.map(
      (taskId) => tasksById.get(taskId) as WorkflowTask,
    ),
    tasksById: Object.fromEntries(
      executionOrder.map((taskId) => [
        taskId,
        tasksById.get(taskId) as WorkflowTask,
      ]),
    ),
    taskIds: executionOrder,
    executionOrder,
  };
}
