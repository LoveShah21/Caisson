import { describe, expect, it } from "vitest";
import { SessionStateMachine } from "../../packages/isolation/src/index.js";

describe("SessionStateMachine", () => {
  it("allows normal lifecycle transitions and a clean termination", () => {
    const machine = new SessionStateMachine("pending");

    for (const status of [
      "booting",
      "ready",
      "active",
      "suspended",
      "terminating",
      "terminated",
    ] as const) {
      machine.transition(status);
    }

    expect(machine.status).toBe("terminated");
    expect(machine.isTerminal).toBe(true);
  });

  it("allows failed from non-terminal states except terminating", () => {
    const failed = new SessionStateMachine("active");
    failed.transition("failed", "driver boot failed after recovery was exhausted");
    expect(failed.status).toBe("failed");

    const terminating = new SessionStateMachine("terminating");
    expect(() => terminating.transition("failed")).toThrow("illegal session transition");
  });

  it("does not transition away from a terminal state", () => {
    const machine = new SessionStateMachine("terminated");
    expect(() => machine.transition("booting")).toThrow("illegal session transition");
  });
});
