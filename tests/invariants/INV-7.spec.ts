/**
 * INV-7. No persistence across sessions.
 * Sandbox disk and memory are destroyed at termination. Nothing written by one
 * session is observable by another restored from the same base snapshot.
 */
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContainerDriver,
  FirecrackerDriver,
  type IsolationDriver,
  type PreparedSandbox,
  VsockInfrastructureProbe,
} from "../../packages/isolation/src/index.js";
import { TestTransportHost } from "../helpers/transport-host.js";

const handles: Array<{
  driver: IsolationDriver;
  prepared: PreparedSandbox;
  transportHost: TestTransportHost;
}> = [];
const firecrackerInv7Enabled =
  process.env.CAISSON_INV7_FIRECRACKER === "1" &&
  process.platform === "linux" &&
  hasKvmAccess() &&
  process.env.CAISSON_INV7_FIRECRACKER_ROOTFS !== undefined &&
  basename(process.env.CAISSON_INV7_FIRECRACKER_ROOTFS) !== "m1-dev-probe-rootfs.ext4";
const firecrackerBootArgs = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/init";

afterEach(async () => {
  await Promise.all(
    handles.splice(0).map(async ({ driver, prepared, transportHost }) => {
      await transportHost.destroyAndRelease(driver, prepared);
    }),
  );
});

describe("INV-7: no persistence across sessions", () => {
  it("destroys a session workspace before a new session starts", async () => {
    const driver = new ContainerDriver();
    await assertNoWorkspacePersistence(driver, "alpine:3.23.3");
  }, 60_000);

  it.skipIf(!firecrackerInv7Enabled)(
    "FirecrackerDriver requires CAISSON_INV7_FIRECRACKER=1, KVM, and an eligible non-M1 rootfs",
    async () => {
      const rootfsPath = requiredEnvironment("CAISSON_INV7_FIRECRACKER_ROOTFS");
      const driver = new FirecrackerDriver({
        firecrackerPath: requiredEnvironment("CAISSON_FIRECRACKER_BIN"),
        kernelImagePath: requiredEnvironment("CAISSON_FIRECRACKER_KERNEL"),
        rootfsPath,
        runtimeDirectory: requiredEnvironment("CAISSON_FIRECRACKER_RUNTIME_DIR"),
        snapshotDirectory: requiredEnvironment("CAISSON_FIRECRACKER_SNAPSHOT_DIR"),
        bootArgs: firecrackerBootArgs,
        infrastructureProbe: new VsockInfrastructureProbe(),
      });
      await assertNoWorkspacePersistence(driver, "caisson-inv7-firecracker");
    },
    60_000,
  );
});

async function assertNoWorkspacePersistence(driver: IsolationDriver, image: string): Promise<void> {
  const transportHost = new TestTransportHost();
  const marker = `caisson-inv7-${randomUUID()}`;
  const firstPrepared = await driver.prepare({ id: randomUUID(), image }, transportHost);
  await driver.start(firstPrepared.handle);
  handles.push({ driver, prepared: firstPrepared, transportHost });

  await driver.exec(firstPrepared.handle, {
    argv: ["/bin/sh", "-c", `printf %s ${marker} > /workspace/marker`],
  });
  await transportHost.destroyAndRelease(driver, firstPrepared);
  removeHandle(firstPrepared.handle.id);

  const secondPrepared = await driver.prepare({ id: randomUUID(), image }, transportHost);
  await driver.start(secondPrepared.handle);
  handles.push({ driver, prepared: secondPrepared, transportHost });
  const result = await driver.exec(secondPrepared.handle, {
    argv: ["/bin/sh", "-c", "test ! -e /workspace/marker"],
  });
  expect(result.exitCode).toBe(0);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`missing required environment variable ${name}`);
  return value;
}

function removeHandle(id: string): void {
  const index = handles.findIndex(({ prepared }) => prepared.handle.id === id);
  if (index >= 0) handles.splice(index, 1);
}

function hasKvmAccess(): boolean {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
