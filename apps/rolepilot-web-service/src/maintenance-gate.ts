/** 单进程入口互斥。执行租约覆盖 claim 到 Worker finally，包括取消后的收尾。 */
export class MaintenanceGate {
  #tail: Promise<unknown> = Promise.resolve();
  #writes = 0;
  #executions = 0;
  #incoming = 0;
  maintaining = true;

  get busy(): boolean { return this.#writes > 0 || this.#executions > 0 || this.#incoming > 0; }

  admitRequest(): () => void {
    if (this.maintaining) throw new MaintenanceBusyError();
    this.#incoming += 1;
    let released = false;
    return () => { if (!released) { released = true; this.#incoming -= 1; } };
  }

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async write<T>(operation: () => Promise<T>): Promise<T> {
    this.#writes += 1;
    try {
      return await this.exclusive(async () => {
        if (this.maintaining) throw new MaintenanceBusyError();
        return operation();
      });
    } finally { this.#writes -= 1; }
  }

  async execute<T>(operation: () => Promise<T>): Promise<T | null> {
    const admitted = await this.exclusive(async () => {
      if (this.maintaining) return false;
      this.#executions += 1;
      return true;
    });
    if (!admitted) return null;
    try { return await operation(); } finally { this.#executions -= 1; }
  }
}

export class MaintenanceBusyError extends Error {
  constructor() { super("INSTANCE_BUSY"); }
}
