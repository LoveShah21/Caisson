export interface ReconciliationTarget {
  reconcile(): Promise<void>;
}

export interface ReconciliationScheduler {
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const nodeScheduler: ReconciliationScheduler = {
  setInterval,
  clearInterval,
};

export class PeriodicReconciler {
  readonly #target: ReconciliationTarget;
  readonly #intervalMs: number;
  readonly #scheduler: ReconciliationScheduler;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(
    target: ReconciliationTarget,
    intervalMs: number,
    scheduler: ReconciliationScheduler = nodeScheduler,
  ) {
    this.#target = target;
    this.#intervalMs = intervalMs;
    this.#scheduler = scheduler;
  }

  async start(): Promise<void> {
    if (this.#timer !== undefined || this.#stopped) return;
    await this.#run();
    if (this.#stopped) return;
    this.#timer = this.#scheduler.setInterval(() => {
      void this.#run().catch(() => undefined);
    }, this.#intervalMs);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      this.#scheduler.clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#running;
  }

  async #run(): Promise<void> {
    if (this.#running !== undefined) {
      return this.#running;
    }
    const running = this.#target.reconcile();
    this.#running = running;
    try {
      await running;
    } finally {
      if (this.#running === running) {
        this.#running = undefined;
      }
    }
  }
}
