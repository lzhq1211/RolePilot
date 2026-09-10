export type RuntimeEventType =
  | "runtime-started"
  | "task-started"
  | "task-completed"
  | "task-failed"
  | "runtime-stopped";

export type RuntimeEvent = {
  sequence: number;
  type: RuntimeEventType;
  taskId?: string;
  stopReason?: string;
};

export function createRuntimeEvent(
  sequence: number,
  type: RuntimeEventType,
  detail: Omit<RuntimeEvent, "sequence" | "type"> = {},
): RuntimeEvent {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error("Runtime event sequence must be a positive integer.");
  }

  return {
    sequence,
    type,
    ...detail,
  };
}
