import { describe, expect, it } from "vitest";

import { bootSandbox } from "../../apps/control-plane/src/boot-sandbox.js";
import type {
  IsolationDriver,
  SandboxHandle,
  TransportDescriptor,
  TransportHost,
} from "../../packages/isolation/src/index.js";

const descriptor: TransportDescriptor = {
  kind: "unix",
  hostId: "test-host",
  peerIdentifier: "/tmp/caisson-test.sock",
};

describe("sandbox boot orchestration", () => {
  it("destroys the prepared sandbox before releasing transport when persistence fails", async () => {
    const events: string[] = [];
    const handle: SandboxHandle = { id: "sandbox", driver: "container" };
    const driver = {
      capabilities: () => ({ hardwareIsolation: false, snapshotSupport: false, maxConcurrent: 1 }),
      prepare: async () => {
        events.push("prepare");
        return { handle, transport: descriptor };
      },
      start: async () => {
        events.push("start");
      },
      destroy: async () => {
        events.push("destroy");
      },
    };
    const transportHost: TransportHost = {
      reserve: async (reservedDescriptor) => ({
        descriptor: reservedDescriptor,
        endpointPath: reservedDescriptor.peerIdentifier,
      }),
      release: async () => {
        events.push("release");
      },
    };

    await expect(
      bootSandbox(
        driver as unknown as IsolationDriver,
        { id: handle.id, image: "test" },
        transportHost,
        async () => {
          events.push("persist");
          throw new Error("database unavailable");
        },
        "cold",
      ),
    ).rejects.toThrow("database unavailable");

    expect(events).toEqual(["prepare", "persist", "destroy", "release"]);
  });
});
