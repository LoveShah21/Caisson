import { describe, expect, it, vi } from "vitest";

import { SessionActionGate } from "../../apps/control-plane/src/session-action-gate.js";

describe("SessionActionGate", () => {
  it("closes admission immediately, drains existing actions, and holds through capture commit", async () => {
    const gate = new SessionActionGate();
    const existing = gate.enter("session-a");
    expect(existing).toBeDefined();
    const checkpoints: string[] = [];

    const capture = gate.withExclusiveCapture("session-a", 1_000, async () => {
      checkpoints.push("capture");
      expect(gate.enter("session-a")).toBeUndefined();
      await Promise.resolve();
      checkpoints.push("dek-and-metadata-committed");
      return "snapshot";
    });

    expect(gate.isCapturePending("session-a")).toBe(true);
    expect(gate.enter("session-a")).toBeUndefined();
    expect(checkpoints).toEqual([]);
    existing?.release();

    await expect(capture).resolves.toBe("snapshot");
    expect(checkpoints).toEqual(["capture", "dek-and-metadata-committed"]);
    expect(gate.enter("session-a")).toBeDefined();
  });

  it("aborts without running capture when in-flight actions miss the required drain timeout", async () => {
    vi.useFakeTimers();
    try {
      const gate = new SessionActionGate();
      const existing = gate.enter("session-timeout");
      const capture = vi.fn(async () => "must-not-run");
      const result = gate.withExclusiveCapture("session-timeout", 50, capture);
      const rejected = expect(result).rejects.toMatchObject({ code: "SANDBOX_FAILED" });

      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(capture).not.toHaveBeenCalled();
      existing?.release();
      expect(gate.isCapturePending("session-timeout")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
