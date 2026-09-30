import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  FirecrackerDriver,
  callRuntimeDiagnostic,
  type LocalSnapshot,
  type PreparedSandbox,
} from "../../packages/isolation/src/index.js";
import { containsSecretShape } from "../../packages/audit/src/index.js";
import { RuntimeVsockTransportHost } from "../helpers/runtime-vsock-transport-host.js";

const runtimeRootfs = process.env.CAISSON_RUNTIME_ROOTFS;
const diagnosticRootfs = process.env.CAISSON_RUNTIME_DIAGNOSTIC_ROOTFS;
const kvmEnabled =
  process.env.CAISSON_RUNTIME_KVM_TESTS === "1" &&
  process.platform === "linux" &&
  runtimeRootfs !== undefined &&
  diagnosticRootfs !== undefined &&
  hasKvmAccess();
const bootArgs = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro init=/init";
const request = {
  id: "runtime-one-shot",
  op: "broker.call" as const,
  body: {
    service: "runtime-test",
    method: "read",
    params: {},
    idempotencyKey: "runtime-one-shot",
    intent: "verify the guest-to-broker transport",
  },
};

const active: Array<{
  driver: FirecrackerDriver;
  prepared: PreparedSandbox;
  host: RuntimeVsockTransportHost;
}> = [];

afterEach(async () => {
  await Promise.all(
    active.splice(0).map(async ({ driver, prepared, host }) => {
      await driver.destroy(prepared.handle);
      await host.release(prepared.transport);
    }),
  );
});

describe("Firecracker M-2 runtime", () => {
  it.skipIf(!kvmEnabled)(
    "round-trips a bounded framed broker.call over real Firecracker vsock",
    async () => {
      const { driver, host, prepared } = await boot(runtimeRootfs!);
      await waitFor(() => host.messages.length === 2);
      expect(JSON.parse(host.messages[0]!)).toEqual(request);
      expect(JSON.parse(host.messages[1]!)).toMatchObject({ id: request.id, ok: true });
      expect(host.messages.some((message) => containsSecretShape(JSON.parse(message)))).toBe(false);
      active.push({ driver, host, prepared });
    },
    90_000,
  );

  it.skipIf(!kvmEnabled)(
    "requires fresh entropy after each restore and produces distinct random output",
    async () => {
      const source = await boot(diagnosticRootfs!);
      await waitForDiagnostic(source);
      const snapshot = await source.driver.snapshot(source.prepared.handle, "base");
      await source.driver.destroy(source.prepared.handle);
      await source.host.release(source.prepared.transport);

      try {
        const first = await restore(diagnosticRootfs!, snapshot);
        const firstRandom = (await waitForDiagnostic(first, { operation: "random" })).value;
        await first.driver.destroy(first.prepared.handle);
        await first.host.release(first.prepared.transport);

        const second = await restore(diagnosticRootfs!, snapshot);
        const secondRandom = (await waitForDiagnostic(second, { operation: "random" })).value;
        await second.driver.destroy(second.prepared.handle);
        await second.host.release(second.prepared.transport);

        expect(firstRandom).toMatch(/^[0-9a-f]{64}$/u);
        expect(secondRandom).toMatch(/^[0-9a-f]{64}$/u);
        expect(secondRandom).not.toBe(firstRandom);
      } finally {
        const { rm } = await import("node:fs/promises");
        await Promise.all([
          rm(snapshot.statePath, { force: true }),
          rm(snapshot.memoryPath, { force: true }),
        ]);
      }
    },
    120_000,
  );
});

async function boot(rootfsPath: string) {
  const driver = makeDriver(rootfsPath);
  const host = new RuntimeVsockTransportHost();
  const prepared = await driver.prepare({ id: randomUUID(), image: "caisson-runtime" }, host);
  try {
    await driver.start(prepared.handle);
  } catch (error: unknown) {
    await driver.destroy(prepared.handle);
    await host.release(prepared.transport);
    throw error;
  }
  return { driver, host, prepared };
}

async function restore(rootfsPath: string, snapshot: LocalSnapshot) {
  const driver = makeDriver(rootfsPath);
  const host = new RuntimeVsockTransportHost();
  const prepared = await driver.restore(
    {
      ref: snapshotRef(snapshot),
      statePath: snapshot.statePath,
      memoryPath: snapshot.memoryPath,
      rootfsPath,
    },
    { id: randomUUID(), image: "caisson-runtime-diagnostic" },
    host,
  );
  try {
    await driver.start(prepared.handle);
  } catch (error: unknown) {
    await driver.destroy(prepared.handle);
    await host.release(prepared.transport);
    throw error;
  }
  return { driver, host, prepared };
}

function makeDriver(rootfsPath: string): FirecrackerDriver {
  return new FirecrackerDriver({
    firecrackerPath: required("CAISSON_FIRECRACKER_BIN"),
    kernelImagePath: required("CAISSON_FIRECRACKER_KERNEL"),
    rootfsPath,
    runtimeDirectory: required("CAISSON_FIRECRACKER_RUNTIME_DIR"),
    snapshotDirectory: required("CAISSON_FIRECRACKER_SNAPSHOT_DIR"),
    bootArgs,
    oneShotBrokerRequest: request,
  });
}

function snapshotRef(snapshot: LocalSnapshot) {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    manifest: { bucket: "test", key: "test", sha256: "0".repeat(64), sizeBytes: 1 },
    manifestKeyId: "test",
    createdAt: snapshot.createdAt,
  };
}

async function waitForDiagnostic(
  context: {
    driver: FirecrackerDriver;
    prepared: PreparedSandbox;
    host: RuntimeVsockTransportHost;
  },
  operation: { operation: "random" } = { operation: "random" },
) {
  const path = context.host.endpointFor(context.prepared.transport);
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await callRuntimeDiagnostic(path, operation);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for guest broker request");
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing ${name}`);
  return value;
}

function hasKvmAccess(): boolean {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
