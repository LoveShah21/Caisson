import { CaissonError } from "@caisson/protocol";

interface SessionGateState {
  closing: boolean;
  active: number;
  readonly drained: Set<() => void>;
}

export interface SessionActionLease {
  release(): void;
}

/**
 * Host-side, per-session admission gate shared by broker calls, local tools,
 * and FR-16 capture. Capture closes admission synchronously before it waits.
 */
export class SessionActionGate {
  readonly #states = new Map<string, SessionGateState>();

  enter(sessionId: string): SessionActionLease | undefined {
    const state = this.#state(sessionId);
    if (state.closing) return undefined;
    state.active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        state.active -= 1;
        if (state.active === 0) {
          for (const resolve of state.drained) resolve();
          state.drained.clear();
        }
        this.#deleteIfIdle(sessionId, state);
      },
    };
  }

  async withExclusiveCapture<T>(
    sessionId: string,
    drainTimeoutMs: number,
    capture: () => Promise<T>,
  ): Promise<T> {
    assertPositive(drainTimeoutMs);
    const state = this.#state(sessionId);
    if (state.closing) {
      throw new CaissonError("SESSION_SUSPENDED", "session snapshot capture is already active");
    }

    // This assignment is deliberately before the first await. New admissions
    // fail immediately from the moment capture acquisition is attempted.
    state.closing = true;
    try {
      await this.#waitForDrain(state, drainTimeoutMs);
      return await capture();
    } finally {
      state.closing = false;
      this.#deleteIfIdle(sessionId, state);
    }
  }

  isCapturePending(sessionId: string): boolean {
    return this.#states.get(sessionId)?.closing ?? false;
  }

  #state(sessionId: string): SessionGateState {
    let state = this.#states.get(sessionId);
    if (state === undefined) {
      state = { closing: false, active: 0, drained: new Set() };
      this.#states.set(sessionId, state);
    }
    return state;
  }

  async #waitForDrain(state: SessionGateState, timeoutMs: number): Promise<void> {
    if (state.active === 0) return;
    await new Promise<void>((resolve, reject) => {
      const onDrained = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        state.drained.delete(onDrained);
        reject(
          new CaissonError(
            "SANDBOX_FAILED",
            "session snapshot action drain timed out without creating a snapshot",
          ),
        );
      }, timeoutMs);
      state.drained.add(onDrained);
    });
  }

  #deleteIfIdle(sessionId: string, state: SessionGateState): void {
    if (!state.closing && state.active === 0 && state.drained.size === 0) {
      this.#states.delete(sessionId);
    }
  }
}

function assertPositive(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CaissonError(
      "SANDBOX_FAILED",
      "session snapshot action-drain timeout configuration is invalid",
    );
  }
}
