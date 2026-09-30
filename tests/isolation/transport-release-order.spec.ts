import { describe, expect, it } from "vitest";
import { destroyPreparedSandbox } from "../../apps/control-plane/src/boot-sandbox.js";
import type {
  PreparedSandbox,
  SandboxHandle,
  TransportDescriptor,
  TransportHost,
} from "../../packages/isolation/src/index.js";

const descriptor: TransportDescriptor = {
  kind: "unix",
  hostId: "test-host",
  peerIdentifier: "/tmp/caisson-test.sock",
};

const prepared: PreparedSandbox = {
  handle: { id: "sandbox", driver: "container" },
  transport: descriptor,
};

describe("transport listener teardown", () => {
  it("rejects a release attempted before destroy completes", async () => {
    let destroyCompleted = false;
    const driver = {
      capabilities: () => ({ hardwareIsolation: false, snapshotSupport: false, maxConcurrent: 1 }),
      destroy: async (_handle: SandboxHandle) => {
        await Promise.resolve();
        destroyCompleted = true;
      },
    };
    const transportHost: TransportHost = {
      reserve: async (reservedDescriptor) => ({
        descriptor: reservedDescriptor,
        endpointPath: reservedDescriptor.peerIdentifier,
      }),
      release: async () => {
        if (!destroyCompleted) {
          throw new Error("release called before sandbox destruction completed");
        }
      },
    };

    await expect(transportHost.release(descriptor)).rejects.toThrow(
      "release called before sandbox destruction completed",
    );
    await expect(
      destroyPreparedSandbox(driver as never, prepared, transportHost),
    ).resolves.toBeUndefined();
  });
});
