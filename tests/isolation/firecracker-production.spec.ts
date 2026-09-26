import { describe, expect, it } from "vitest";

import { FirecrackerDriver } from "../../packages/isolation/src/index.js";

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
      await expect(driver.create({ id: "probe-refusal", image: "m1-dev-probe" })).rejects.toThrow(
        "production refuses the M-1 development probe rootfs",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.CAISSON_ENV;
      } else {
        process.env.CAISSON_ENV = previous;
      }
    }
  });
});
