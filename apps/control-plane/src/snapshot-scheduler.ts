import type { SnapshotRef } from "@caisson/isolation";

export interface SnapshotSchedulerStore {
  buildBaseSnapshot(): Promise<SnapshotRef>;
  promoteBaseSnapshotAtomically(snapshot: SnapshotRef): Promise<void>;
  snapshotActiveSessions(): Promise<void>;
}

export class SnapshotScheduler {
  readonly #store: SnapshotSchedulerStore;
  readonly #now: () => Date;
  #lastBaseBuildAt: Date | undefined;
  #lastSessionSnapshotAt: Date | undefined;

  constructor(store: SnapshotSchedulerStore, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  async runOnce(): Promise<void> {
    const now = this.#now();
    if (this.#isDue(this.#lastBaseBuildAt, 30 * 60 * 1_000, now)) {
      const snapshot = await this.#store.buildBaseSnapshot();
      await this.#store.promoteBaseSnapshotAtomically(snapshot);
      this.#lastBaseBuildAt = now;
    }
    if (this.#isDue(this.#lastSessionSnapshotAt, 5 * 60 * 1_000, now)) {
      await this.#store.snapshotActiveSessions();
      this.#lastSessionSnapshotAt = now;
    }
  }

  #isDue(previous: Date | undefined, intervalMs: number, now: Date): boolean {
    return previous === undefined || previous.getTime() + intervalMs <= now.getTime();
  }
}
