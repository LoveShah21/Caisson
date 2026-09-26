import { CaissonError, type SessionStatus } from "@caisson/protocol";

const TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  pending: ["booting", "terminating", "failed"],
  booting: ["ready", "terminating", "failed"],
  ready: ["active", "terminating", "failed"],
  active: ["suspended", "terminating", "failed"],
  suspended: ["active", "terminating", "failed"],
  terminating: ["terminated"],
  terminated: [],
  failed: [],
};

export interface SessionTransitionEvent {
  readonly from: SessionStatus;
  readonly to: SessionStatus;
  readonly reason?: string;
  readonly legal: boolean;
}

export type SessionTransitionObserver = (event: SessionTransitionEvent) => void;

export class SessionStateMachine {
  #status: SessionStatus;
  readonly #observe: SessionTransitionObserver | undefined;

  constructor(initial: SessionStatus = "pending", observe?: SessionTransitionObserver) {
    this.#status = initial;
    this.#observe = observe;
  }

  get status(): SessionStatus {
    return this.#status;
  }

  get isTerminal(): boolean {
    return this.#status === "terminated" || this.#status === "failed";
  }

  transition(to: SessionStatus, reason?: string): void {
    const from = this.#status;
    if (!TRANSITIONS[from].includes(to)) {
      this.#emit(from, to, reason, false);
      throw new CaissonError("INVALID_REQUEST", `illegal session transition from ${from} to ${to}`);
    }

    this.#status = to;
    this.#emit(from, to, reason, true);
  }

  #emit(from: SessionStatus, to: SessionStatus, reason: string | undefined, legal: boolean): void {
    if (reason === undefined) {
      this.#observe?.({ from, to, legal });
      return;
    }
    this.#observe?.({ from, to, reason, legal });
  }
}
