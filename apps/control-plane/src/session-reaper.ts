import type { SessionStatus } from "@caisson/protocol";

export interface ReapableSession {
  readonly id: string;
  readonly status: SessionStatus;
  readonly expiresAt: Date;
  readonly lastActivityAt: Date;
  readonly idleTimeoutSeconds: number;
}

export interface SessionReaperStore {
  listNonTerminal(): Promise<readonly ReapableSession[]>;
  suspend(sessionId: string, reason: "idle_timeout"): Promise<void>;
  terminate(sessionId: string, reason: "ttl_expired"): Promise<void>;
}

export class SessionReaper {
  readonly #store: SessionReaperStore;
  readonly #now: () => Date;

  constructor(store: SessionReaperStore, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  async runOnce(): Promise<void> {
    const now = this.#now();
    const sessions = await this.#store.listNonTerminal();
    await Promise.all(
      sessions.map(async (session) => {
        if (session.expiresAt <= now) {
          await this.#store.terminate(session.id, "ttl_expired");
          return;
        }
        if (
          session.status === "active" &&
          session.lastActivityAt.getTime() + session.idleTimeoutSeconds * 1_000 <= now.getTime()
        ) {
          await this.#store.suspend(session.id, "idle_timeout");
        }
      }),
    );
  }
}
