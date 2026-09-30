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
  callRuntimeDiagnostic,
  ContainerDriver,
  FirecrackerDriver,
  type IsolationDriver,
  type LocalSnapshot,
  type PreparedSandbox,
} from "../../packages/isolation/src/index.js";
import { TestTransportHost } from "../helpers/transport-host.js";
import { RuntimeVsockTransportHost } from "../helpers/runtime-vsock-transport-host.js";

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
  basename(process.env.CAISSON_INV7_FIRECRACKER_ROOTFS) ===
    "caisson-runtime-diagnostic-rootfs.ext4";
const firecrackerBootArgs = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro init=/init";
const runtimeRequest = {
  id: "inv7-runtime",
  op: "broker.call" as const,
  body: {
    service: "runtime-test",
    method: "read",
    params: {},
    idempotencyKey: "inv7-runtime",
    intent: "verify no persistence across diagnostic restores",
  },
};

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
    "FirecrackerDriver requires CAISSON_INV7_FIRECRACKER=1, KVM, and the diagnostic runtime rootfs",
    async () => {
      const rootfsPath = requiredEnvironment("CAISSON_INV7_FIRECRACKER_ROOTFS");
      const driver = new FirecrackerDriver({
        firecrackerPath: requiredEnvironment("CAISSON_FIRECRACKER_BIN"),
        kernelImagePath: requiredEnvironment("CAISSON_FIRECRACKER_KERNEL"),
        rootfsPath,
        runtimeDirectory: requiredEnvironment("CAISSON_FIRECRACKER_RUNTIME_DIR"),
        snapshotDirectory: requiredEnvironment("CAISSON_FIRECRACKER_SNAPSHOT_DIR"),
        bootArgs: firecrackerBootArgs,
        oneShotBrokerRequest: runtimeRequest,
      });
      await assertNoRuntimePersistence(driver, rootfsPath);
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

async function assertNoRuntimePersistence(
  driver: FirecrackerDriver,
  rootfsPath: string,
): Promise<void> {
  const sourceHost = new RuntimeVsockTransportHost();
  const source = await driver.prepare(
    { id: randomUUID(), image: "caisson-runtime-diagnostic" },
    sourceHost,
  );
  await driver.start(source.handle);
  await waitForDiagnostic(sourceHost, source);
  const snapshot = await driver.snapshot(source.handle, "base");
  await driver.destroy(source.handle);
  await sourceHost.release(source.transport);

  try {
    const firstHost = new RuntimeVsockTransportHost();
    const first = await driver.restore(
      resolveSnapshot(snapshot, rootfsPath),
      { id: randomUUID(), image: "diagnostic" },
      firstHost,
    );
    await driver.start(first.handle);
    await waitForDiagnostic(firstHost, first, {
      operation: "write_marker",
      path: "/dev/shm/caisson-marker",
      value: `caisson-inv7-${randomUUID()}`,
    });
    await driver.destroy(first.handle);
    await firstHost.release(first.transport);

    const secondHost = new RuntimeVsockTransportHost();
    const second = await driver.restore(
      resolveSnapshot(snapshot, rootfsPath),
      { id: randomUUID(), image: "diagnostic" },
      secondHost,
    );
    await driver.start(second.handle);
    const result = await waitForDiagnostic(secondHost, second, {
      operation: "read_marker",
      path: "/dev/shm/caisson-marker",
    });
    expect(result.value).toBeUndefined();
    await driver.destroy(second.handle);
    await secondHost.release(second.transport);
  } finally {
    const { rm } = await import("node:fs/promises");
    await Promise.all([
      rm(snapshot.statePath, { force: true }),
      rm(snapshot.memoryPath, { force: true }),
    ]);
  }
}

function resolveSnapshot(snapshot: LocalSnapshot, rootfsPath: string) {
  return {
    ref: {
      id: snapshot.id,
      kind: snapshot.kind,
      manifest: { bucket: "test", key: "test", sha256: "0".repeat(64), sizeBytes: 1 },
      manifestKeyId: "test",
      createdAt: snapshot.createdAt,
    },
    statePath: snapshot.statePath,
    memoryPath: snapshot.memoryPath,
    rootfsPath,
  };
}

async function waitForDiagnostic(
  host: RuntimeVsockTransportHost,
  prepared: PreparedSandbox,
  request: Parameters<typeof callRuntimeDiagnostic>[1] = { operation: "random" },
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await callRuntimeDiagnostic(host.endpointFor(prepared.transport), request);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
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
