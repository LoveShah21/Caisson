import { describe, expect, it, vi } from "vitest";

import { SessionReaper } from "../../apps/control-plane/src/session-reaper.js";
import { SnapshotScheduler } from "../../apps/control-plane/src/snapshot-scheduler.js";

describe("SessionReaper", () => {
  it("terminates expired sessions and suspends idle active sessions", async () => {
    const terminate = vi.fn();
    const suspend = vi.fn();
    const now = new Date("2026-09-26T12:00:00Z");
    const reaper = new SessionReaper(
      {
        listNonTerminal: async () => [
          {
            id: "expired",
            status: "ready",
            expiresAt: new Date("2026-09-26T11:59:59Z"),
            lastActivityAt: now,
            idleTimeoutSeconds: 300,
          },
          {
            id: "idle",
            status: "active",
            expiresAt: new Date("2026-09-26T13:00:00Z"),
            lastActivityAt: new Date("2026-09-26T11:54:59Z"),
            idleTimeoutSeconds: 300,
          },
        ],
        suspend,
        terminate,
      },
      () => now,
    );

    await reaper.runOnce();

    expect(terminate).toHaveBeenCalledWith("expired", "ttl_expired");
    expect(suspend).toHaveBeenCalledWith("idle", "idle_timeout");
  });
});

describe("SnapshotScheduler", () => {
  it("builds and atomically promotes a base snapshot before scheduling session snapshots", async () => {
    const buildBaseSnapshot = vi.fn(async () => ({
      id: "base",
      kind: "base" as const,
      statePath: "/snapshots/base.state",
      memoryPath: "/snapshots/base.memory",
      createdAt: "2026-09-26T12:00:00Z",
    }));
    const promoteBaseSnapshotAtomically = vi.fn();
    const snapshotActiveSessions = vi.fn();
    const scheduler = new SnapshotScheduler(
      { buildBaseSnapshot, promoteBaseSnapshotAtomically, snapshotActiveSessions },
      () => new Date("2026-09-26T12:00:00Z"),
    );

    await scheduler.runOnce();

    expect(buildBaseSnapshot).toHaveBeenCalledOnce();
    expect(promoteBaseSnapshotAtomically).toHaveBeenCalledWith(
      expect.objectContaining({ id: "base" }),
    );
    expect(snapshotActiveSessions).toHaveBeenCalledOnce();
    expect(promoteBaseSnapshotAtomically.mock.invocationCallOrder[0]).toBeLessThan(
      snapshotActiveSessions.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
