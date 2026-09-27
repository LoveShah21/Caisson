import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ContainerDriver,
  FirecrackerDriver,
  VsockInfrastructureProbe,
} from "../../packages/isolation/src/index.js";
import { TestTransportHost } from "../helpers/transport-host.js";

const FIRECRACKER_BOOT_ARGS = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/init";
const manualFirecracker = process.env.CAISSON_MANUAL_FC_TEST === "1";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

describe("M-1 driver mechanism", () => {
  it("runs echo through ContainerDriver and destroys the sandbox", async () => {
    const driver = new ContainerDriver({ warn: () => undefined });
    const transportHost = new TestTransportHost();
    const prepared = await driver.prepare(
      { id: randomUUID(), image: "alpine:3.23.3" },
      transportHost,
    );
    await driver.start(prepared.handle);
    const handle = prepared.handle;
    try {
      await expect(driver.exec(handle, { argv: ["/bin/echo", "hello"] })).resolves.toMatchObject({
        exitCode: 0,
        stderr: "",
        stdout: "hello\n",
      });
    } finally {
      await transportHost.destroyAndRelease(driver, prepared);
    }
  }, 60_000);

  it.skipIf(!manualFirecracker)(
    "runs echo through FirecrackerDriver and destroys the sandbox",
    async () => {
      const rootfsPath = requiredEnvironment("CAISSON_FIRECRACKER_ROOTFS");
      expect(basename(rootfsPath)).toBe("m1-dev-probe-rootfs.ext4");
      const driver = new FirecrackerDriver({
        firecrackerPath: requiredEnvironment("CAISSON_FIRECRACKER_BIN"),
        kernelImagePath: requiredEnvironment("CAISSON_FIRECRACKER_KERNEL"),
        rootfsPath,
        runtimeDirectory: requiredEnvironment("CAISSON_FIRECRACKER_RUNTIME_DIR"),
        snapshotDirectory: requiredEnvironment("CAISSON_FIRECRACKER_SNAPSHOT_DIR"),
        bootArgs: FIRECRACKER_BOOT_ARGS,
        infrastructureProbe: new VsockInfrastructureProbe(),
      });
      const transportHost = new TestTransportHost();
      const prepared = await driver.prepare(
        { id: randomUUID(), image: "m1-dev-probe" },
        transportHost,
      );
      await driver.start(prepared.handle);
      const handle = prepared.handle;
      try {
        await expect(driver.exec(handle, { argv: ["/bin/echo", "hello"] })).resolves.toMatchObject({
          exitCode: 0,
          stderr: "",
          stdout: "hello\n",
        });
      } finally {
        await transportHost.destroyAndRelease(driver, prepared);
      }
    },
    60_000,
  );
});
