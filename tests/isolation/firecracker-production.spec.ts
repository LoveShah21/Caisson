import { describe, expect, it } from "vitest";

import { FirecrackerDriver } from "../../packages/isolation/src/index.js";

const transportHost = {
  reserve: async (descriptor: { readonly peerIdentifier: string }) => ({
    descriptor,
    endpointPath: descriptor.peerIdentifier,
  }),
  release: async () => undefined,
};

describe("Firecracker M-1 development probe boundary", () => {
  it("refuses the development probe rootfs in production before host checks", async () => {
    const previous = process.env.CAISSON_ENV;
    process.env.CAISSON_ENV = "production";
    const driver = new FirecrackerDriver({
      firecrackerPath: "/not-used/firecracker",
      kernelImagePath: "/not-used/vmlinux",
      rootfsPath: "/not-used/m1-dev-probe-rootfs.ext4",
      runtimeDirectory: "/not-used/runtime",
      snapshotDirectory: "/not-used/snapshots",
    });

    try {
      await expect(
        driver.prepare({ id: "probe-refusal", image: "m1-dev-probe" }, transportHost),
      ).rejects.toThrow("production refuses an ineligible development or diagnostic rootfs");
    } finally {
      if (previous === undefined) {
        delete process.env.CAISSON_ENV;
      } else {
        process.env.CAISSON_ENV = previous;
      }
    }
  });

  it("refuses the diagnostic runtime rootfs in production before host checks", async () => {
    const previous = process.env.CAISSON_ENV;
    process.env.CAISSON_ENV = "production";
    const driver = new FirecrackerDriver({
      firecrackerPath: "/not-used/firecracker",
      kernelImagePath: "/not-used/vmlinux",
      rootfsPath: "/not-used/caisson-runtime-diagnostic-rootfs.ext4",
      runtimeDirectory: "/not-used/runtime",
      snapshotDirectory: "/not-used/snapshots",
    });
    try {
      await expect(
        driver.prepare({ id: "diagnostic-refusal", image: "diagnostic" }, transportHost),
      ).rejects.toThrow("production refuses an ineligible development or diagnostic rootfs");
    } finally {
      if (previous === undefined) delete process.env.CAISSON_ENV;
      else process.env.CAISSON_ENV = previous;
    }
  });

  it("refuses the M-3 diagnostic agent rootfs in production before host checks", async () => {
    const previous = process.env.CAISSON_ENV;
    process.env.CAISSON_ENV = "production";
    const driver = new FirecrackerDriver({
      firecrackerPath: "/not-used/firecracker",
      kernelImagePath: "/not-used/vmlinux",
      rootfsPath: "/not-used/caisson-agent-runtime-diagnostic-rootfs.ext4",
      runtimeDirectory: "/not-used/runtime",
      snapshotDirectory: "/not-used/snapshots",
    });
    try {
      await expect(
        driver.prepare(
          { id: "agent-diagnostic-refusal", image: "agent-diagnostic" },
          transportHost,
        ),
      ).rejects.toThrow("production refuses an ineligible development or diagnostic rootfs");
    } finally {
      if (previous === undefined) delete process.env.CAISSON_ENV;
      else process.env.CAISSON_ENV = previous;
    }
  });
});
