import { randomUUID } from "node:crypto";

import type { RunRecord } from "./run-types.js";
import type { RunService } from "./run-service.js";

/** 同进程 Worker 使用的唤醒信号；队列真值仍在 Repository。 */
export class InProcessRunQueue {
  readonly #runService: RunService;
  readonly #waiters = new Set<() => void>();

  constructor(runService: RunService) {
    this.#runService = runService;
  }

  wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

  async waitForSignal({ timeoutMs = 1_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", finish);
        this.#waiters.delete(finish);
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      this.#waiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  claimNext(): Promise<RunRecord | null> {
    return this.#runService.claimNext(randomUUID());
  }
}
