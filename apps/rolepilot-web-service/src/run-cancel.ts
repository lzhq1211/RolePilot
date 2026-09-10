import { randomUUID } from "node:crypto";
import type { RunEventHub } from "./run-events.js";
import type { RunRepository } from "./run-repository.js";
import type { RunService } from "./run-service.js";

export class RunCancellationRegistry {
  readonly #controllers = new Map<string, AbortController>();
  register(runId: string, controller: AbortController): void { this.#controllers.set(runId, controller); }
  unregister(runId: string): void { this.#controllers.delete(runId); }
  cancel(runId: string): boolean { const controller = this.#controllers.get(runId); if (!controller) return false; controller.abort(); return true; }
  has(runId: string): boolean { return this.#controllers.has(runId); }
}

export async function cancelRun({ runService, runRepository, runId, eventHub, idFactory = randomUUID, now = () => new Date() }: { runService: RunService; runRepository: RunRepository; runId: string; eventHub?: RunEventHub; idFactory?: () => string; now?: () => Date }) {
  const current = await runService.get(runId);
  if (!current) return null;
  if (current.status !== "QUEUED" && current.status !== "RUNNING") throw new Error("RUN_NOT_CANCELLABLE");
  const event = { id: idFactory(), runId, sequence: current.lastEventSequence + 1, type: "run.cancelled" as const, payload: { runId, status: "CANCELLED" as const, stopReason: "cancelled" as const }, createdAt: now().toISOString() };
  const cancelled = await runRepository.transition({ runId, expectedStatus: current.status, nextStatus: "CANCELLED", currentStep: current.currentStep, stepStatuses: current.stepStatuses, stopReason: "cancelled", failureCode: null, completedAt: event.createdAt, event });
  eventHub?.publish(event);
  return cancelled;
}
