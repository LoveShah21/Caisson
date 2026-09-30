import type { SpawnOptions } from "node:child_process";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, constants, mkdir, open, rm } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";

import { BrokerCallRequestSchema, CaissonError, type DriverCapabilities } from "@caisson/protocol";

import { callFirecrackerApi } from "./firecracker-api.js";
import {
  firecrackerRootfsDriveConfig,
  isIneligibleBaseRootfs,
} from "./firecracker-drive-config.js";
import type {
  ExecRequest,
  ExecResult,
  IsolationDriver,
  LocalSnapshot,
  PreparedSandbox,
  ResolvedSnapshot,
  SandboxHandle,
  SandboxSpec,
  TransportDescriptor,
  TransportHost,
} from "./types.js";
import { CAISSON_INFRA_PROBE_PORT } from "./vsock-infrastructure-probe.js";

const CAISSON_RUNTIME_ENTROPY_PORT = 1025;

const DEFAULT_BOOT_ARGS = "console=ttyS0 reboot=k panic=1 pci=off";
const DEFAULT_GUEST_READY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 50;
const MAX_RUNTIME_BOOT_REQUEST_BYTES = 2048;

export interface InfrastructureProbe {
  waitForReady(context: InfrastructureProbeContext, timeoutMs: number): Promise<void>;
  execute(
    handle: SandboxHandle,
    request: ExecRequest,
    context: InfrastructureProbeContext,
  ): Promise<ExecResult>;
}

function withOneShotBrokerRequest(bootArgs: string, request: unknown): string {
  if (request === undefined) return bootArgs;
  const parsed = BrokerCallRequestSchema.safeParse(request);
  if (!parsed.success)
    throw new CaissonError("PARAMS_INVALID", "runtime broker request is invalid");
  const encoded = Buffer.from(JSON.stringify(parsed.data), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded) > MAX_RUNTIME_BOOT_REQUEST_BYTES) {
    throw new CaissonError("PARAMS_INVALID", "runtime broker request exceeds boot parameter limit");
  }
  return `${bootArgs} caisson.broker_request_b64=${encoded}`;
}

async function refreshRuntimeEntropy(vsockPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(vsockPath);
    let reply = "";
    let sentEntropy = false;
    let settled = false;
    const finish = (error?: CaissonError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      finish(new CaissonError("SANDBOX_FAILED", "guest entropy confirmation timed out"));
    }, 30_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`CONNECT ${CAISSON_RUNTIME_ENTROPY_PORT}\n`));
    socket.on("data", (chunk: string) => {
      reply += chunk;
      const newline = reply.indexOf("\n");
      if (newline === -1) return;
      if (!/^OK \d+$/u.test(reply.slice(0, newline))) {
        finish(new CaissonError("SANDBOX_FAILED", "guest entropy CONNECT was rejected"));
        return;
      }
      const rest = reply.slice(newline + 1);
      if (!sentEntropy) {
        sentEntropy = true;
        socket.write(randomBytes(32));
      }
      if (rest.includes("ENTROPY_OK\n")) {
        finish();
      }
    });
    socket.once("error", (error) => {
      finish(new CaissonError("SANDBOX_FAILED", "guest entropy refresh failed", undefined, error));
    });
  });
}

export interface InfrastructureProbeContext {
  readonly vsockPath: string;
  readonly port: number;
}

export interface FirecrackerDriverOptions {
  readonly firecrackerPath: string;
  readonly kernelImagePath: string;
  readonly rootfsPath: string;
  readonly runtimeDirectory: string;
  readonly snapshotDirectory: string;
  readonly guestCidStart?: number;
  readonly hostId?: string;
  readonly vcpuCount?: number;
  readonly memoryMiB?: number;
  readonly maxConcurrent?: number;
  readonly bootArgs?: string;
  readonly infrastructureProbe?: InfrastructureProbe;
  readonly oneShotBrokerRequest?: unknown;
}

interface FirecrackerRecord {
  readonly apiSocketPath: string;
  readonly logPath: string;
  readonly process: ChildProcess;
  readonly runtimePath: string;
  readonly vsockPath: string;
  readonly guestCid: number;
  readonly transport: TransportDescriptor;
  readonly restored: boolean;
}

export function firecrackerProcessSpawnOptions(logFileDescriptor: number): SpawnOptions {
  return {
    shell: false,
    stdio: ["ignore", logFileDescriptor, logFileDescriptor],
    windowsHide: true,
  };
}

/**
 * Linux and KVM only. It configures no guest network interface, so a fresh
 * microVM has no route other than its explicitly configured vsock device.
 */
export class FirecrackerDriver implements IsolationDriver {
  readonly #options: Required<
    Omit<FirecrackerDriverOptions, "infrastructureProbe" | "oneShotBrokerRequest">
  > &
    Pick<FirecrackerDriverOptions, "infrastructureProbe" | "oneShotBrokerRequest">;
  readonly #records = new Map<string, FirecrackerRecord>();
  readonly #releasedGuestCids = new Set<number>();
  readonly #allocatedGuestCids = new Map<string, number>();
  readonly #bootArgs: string;
  #nextGuestCid: number;

  constructor(options: FirecrackerDriverOptions) {
    this.#options = {
      ...options,
      guestCidStart: options.guestCidStart ?? 10_000,
      hostId: options.hostId ?? "local",
      vcpuCount: options.vcpuCount ?? 1,
      memoryMiB: options.memoryMiB ?? 512,
      maxConcurrent: options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      bootArgs: options.bootArgs ?? DEFAULT_BOOT_ARGS,
    };
    this.#nextGuestCid = this.#options.guestCidStart;
    this.#bootArgs = withOneShotBrokerRequest(this.#options.bootArgs, options.oneShotBrokerRequest);
  }

  capabilities(): DriverCapabilities {
    return {
      hardwareIsolation: true,
      snapshotSupport: true,
      maxConcurrent: this.#options.maxConcurrent,
    };
  }

  async prepare(spec: SandboxSpec, transportHost: TransportHost): Promise<PreparedSandbox> {
    this.#assertProductionRootfs();
    await this.#assertHostRequirements();
    if (this.#records.size >= this.#options.maxConcurrent) {
      throw new CaissonError("SANDBOX_FAILED", "Firecracker driver concurrency limit reached");
    }

    const guestCid = this.#allocateGuestCid(spec.id);
    const transport: TransportDescriptor = {
      kind: "vsock",
      hostId: this.#options.hostId,
      peerIdentifier: String(guestCid),
    };
    const attachment = await transportHost.reserve(transport);
    if (
      attachment.descriptor.kind !== transport.kind ||
      attachment.descriptor.hostId !== transport.hostId ||
      attachment.descriptor.peerIdentifier !== transport.peerIdentifier
    ) {
      throw new CaissonError("SANDBOX_FAILED", "Firecracker transport attachment is invalid");
    }
    let record: FirecrackerRecord | undefined;
    try {
      record = await this.#startProcess(spec.id, guestCid, transport, attachment.endpointPath);
      await this.#callApi(record, "PUT", "/machine-config", {
        vcpu_count: this.#options.vcpuCount,
        mem_size_mib: this.#options.memoryMiB,
        smt: false,
      });
      await this.#callApi(record, "PUT", "/boot-source", {
        kernel_image_path: this.#options.kernelImagePath,
        boot_args: this.#bootArgs,
      });
      await this.#callApi(
        record,
        "PUT",
        "/drives/rootfs",
        firecrackerRootfsDriveConfig(this.#options.rootfsPath),
      );
      await this.#callApi(record, "PUT", "/vsock", {
        guest_cid: guestCid,
        uds_path: record.vsockPath,
      });
      this.#records.set(spec.id, record);
      return { handle: { id: spec.id, driver: "firecracker" }, transport };
    } catch (error: unknown) {
      if (record !== undefined) {
        this.#records.set(spec.id, record);
        await this.destroy({ id: spec.id, driver: "firecracker" });
      } else {
        this.#releaseGuestCid(spec.id);
      }
      await transportHost.release(transport);
      throw error;
    }
  }

  async start(handle: SandboxHandle): Promise<void> {
    const record = this.#getRecord(handle);
    if (record.restored) {
      await this.#callApi(record, "PATCH", "/vm", { state: "Resumed" });
    } else {
      await this.#callApi(record, "PUT", "/actions", { action_type: "InstanceStart" });
    }
    if (this.#options.oneShotBrokerRequest !== undefined) {
      await refreshRuntimeEntropy(record.vsockPath);
    } else {
      await this.#waitForGuestReady(record);
    }
  }

  async exec(handle: SandboxHandle, request: ExecRequest): Promise<ExecResult> {
    this.#getRecord(handle);
    if (request.argv.length === 0) {
      throw new CaissonError(
        "INVALID_REQUEST",
        "infrastructure exec requires a non-empty argv array",
      );
    }
    if (this.#options.infrastructureProbe === undefined) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "Firecracker infrastructure probe is not configured",
      );
    }
    const record = this.#getRecord(handle);
    return this.#options.infrastructureProbe.execute(handle, request, {
      vsockPath: record.vsockPath,
      port: CAISSON_INFRA_PROBE_PORT,
    });
  }

  async snapshot(handle: SandboxHandle, kind: "base" | "session"): Promise<LocalSnapshot> {
    const record = this.#getRecord(handle);
    const id = randomUUID();
    await mkdir(this.#options.snapshotDirectory, { recursive: true });
    const statePath = join(this.#options.snapshotDirectory, `${id}.state`);
    const memoryPath = join(this.#options.snapshotDirectory, `${id}.memory`);

    await this.#callApi(record, "PATCH", "/vm", { state: "Paused" });
    try {
      await this.#callApi(record, "PUT", "/snapshot/create", {
        snapshot_type: "Full",
        snapshot_path: statePath,
        mem_file_path: memoryPath,
      });
    } finally {
      await this.#callApi(record, "PATCH", "/vm", { state: "Resumed" });
    }

    return {
      id,
      kind,
      statePath,
      memoryPath,
      rootfsPath: this.#options.rootfsPath,
      kernelPath: this.#options.kernelImagePath,
      createdAt: new Date().toISOString(),
    };
  }

  async restore(
    ref: ResolvedSnapshot,
    spec: SandboxSpec,
    transportHost: TransportHost,
  ): Promise<PreparedSandbox> {
    this.#assertProductionRootfs();
    if (ref.rootfsPath !== undefined && ref.rootfsPath !== this.#options.rootfsPath) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "Firecracker restore rootfs path does not match the snapshot backing path",
      );
    }
    await this.#assertHostRequirements();
    const guestCid = this.#allocateGuestCid(spec.id);
    const transport: TransportDescriptor = {
      kind: "vsock",
      hostId: this.#options.hostId,
      peerIdentifier: String(guestCid),
    };
    const attachment = await transportHost.reserve(transport);
    if (
      attachment.descriptor.kind !== transport.kind ||
      attachment.descriptor.hostId !== transport.hostId ||
      attachment.descriptor.peerIdentifier !== transport.peerIdentifier
    ) {
      throw new CaissonError("SANDBOX_FAILED", "Firecracker transport attachment is invalid");
    }
    let record: FirecrackerRecord | undefined;
    try {
      record = {
        ...(await this.#startProcess(spec.id, guestCid, transport, attachment.endpointPath)),
        restored: true,
      };
      await this.#callApi(record, "PUT", "/snapshot/load", {
        snapshot_path: ref.statePath,
        mem_file_path: ref.memoryPath,
        resume_vm: false,
        vsock_override: { uds_path: record.vsockPath },
      });
      this.#records.set(spec.id, record);
      return { handle: { id: spec.id, driver: "firecracker" }, transport };
    } catch (error: unknown) {
      if (record !== undefined) {
        this.#records.set(spec.id, record);
        await this.destroy({ id: spec.id, driver: "firecracker" });
      } else {
        this.#releaseGuestCid(spec.id);
      }
      await transportHost.release(transport);
      throw error;
    }
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const record = this.#getRecord(handle);
    this.#records.delete(handle.id);
    await this.#stopProcess(record, this.#manualDiagnosticsEnabled());
    this.#releaseGuestCid(handle.id);
  }

  async #assertHostRequirements(): Promise<void> {
    if (process.platform !== "linux") {
      throw new CaissonError("SANDBOX_FAILED", "Firecracker requires a Linux host");
    }
    try {
      await Promise.all([
        access("/dev/kvm", constants.R_OK | constants.W_OK),
        access("/dev/vhost-vsock", constants.R_OK | constants.W_OK),
        access(this.#options.firecrackerPath, constants.X_OK),
        access(this.#options.kernelImagePath, constants.R_OK),
        access(this.#options.rootfsPath, constants.R_OK),
      ]);
    } catch (error: unknown) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "Firecracker host requirements are unavailable",
        undefined,
        error,
      );
    }
  }

  #assertProductionRootfs(): void {
    const environment: unknown = Reflect.get(process.env, "CAISSON_ENV");
    if (environment === "production" && isIneligibleBaseRootfs(this.#options.rootfsPath)) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "production refuses an ineligible development or diagnostic rootfs",
      );
    }
  }

  async #startProcess(
    sessionId: string,
    guestCid: number,
    transport: TransportDescriptor,
    vsockPath: string,
  ): Promise<FirecrackerRecord> {
    const runtimePath = join(this.#options.runtimeDirectory, this.#safePathSegment(sessionId));
    const apiSocketPath = join(runtimePath, "firecracker.sock");
    const logPath = join(runtimePath, "firecracker.log");
    await mkdir(runtimePath, { recursive: true });
    const logFile = await open(logPath, "a");
    let process: ChildProcess;
    let spawnError: unknown;
    try {
      this.#diagnostic("spawning Firecracker process");
      process = spawn(
        this.#options.firecrackerPath,
        ["--api-sock", apiSocketPath],
        firecrackerProcessSpawnOptions(logFile.fd),
      );
      process.once("error", (error: Error) => {
        spawnError = error;
      });
    } finally {
      await logFile.close();
    }
    this.#diagnostic("waiting for Firecracker API socket");
    await this.#waitForApiSocket(process, apiSocketPath, () => spawnError);
    this.#diagnostic("Firecracker API socket is ready");
    return {
      apiSocketPath,
      logPath,
      process,
      runtimePath,
      vsockPath,
      guestCid,
      transport,
      restored: false,
    };
  }

  async #stopProcess(record: FirecrackerRecord, preserveRuntime = false): Promise<void> {
    if (!record.process.killed) {
      record.process.kill("SIGKILL");
    }
    if (!preserveRuntime) {
      await rm(record.runtimePath, { force: true, recursive: true });
    }
  }

  async #waitForApiSocket(
    process: ChildProcess,
    apiSocketPath: string,
    getSpawnError: () => unknown,
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const spawnError = getSpawnError();
      if (spawnError !== undefined) {
        throw new CaissonError(
          "SANDBOX_FAILED",
          "Firecracker process could not start",
          undefined,
          spawnError,
        );
      }
      if (process.exitCode !== null) {
        throw new CaissonError(
          "SANDBOX_FAILED",
          "Firecracker exited before opening its API socket",
        );
      }
      try {
        await access(apiSocketPath, constants.R_OK | constants.W_OK);
        return;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new CaissonError("SANDBOX_FAILED", "Firecracker did not open its API socket");
  }

  async #callApi(
    record: FirecrackerRecord,
    method: "GET" | "PATCH" | "PUT",
    path: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.#diagnostic(`sending Firecracker API request: ${method} ${path}`);
    await callFirecrackerApi(record.apiSocketPath, method, path, body);
  }

  async #waitForGuestReady(record: FirecrackerRecord): Promise<void> {
    if (this.#options.infrastructureProbe === undefined) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "Firecracker infrastructure probe is required to confirm guest readiness",
      );
    }
    this.#diagnostic("waiting for guest vsock readiness");
    await this.#options.infrastructureProbe.waitForReady(
      { port: CAISSON_INFRA_PROBE_PORT, vsockPath: record.vsockPath },
      DEFAULT_GUEST_READY_TIMEOUT_MS,
    );
    this.#diagnostic("guest vsock is ready");
  }

  #manualDiagnosticsEnabled(): boolean {
    return Reflect.get(process.env, "CAISSON_MANUAL_FC_TEST") === "1";
  }

  #diagnostic(message: string): void {
    if (this.#manualDiagnosticsEnabled()) {
      console.log(`FirecrackerDriver: ${message}`);
    }
  }

  #getRecord(handle: SandboxHandle): FirecrackerRecord {
    if (handle.driver !== "firecracker") {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "Firecracker driver received a foreign sandbox handle",
      );
    }
    const record = this.#records.get(handle.id);
    if (record === undefined) {
      throw new CaissonError("SESSION_NOT_FOUND", "sandbox handle is no longer active");
    }
    return record;
  }

  #allocateGuestCid(sessionId: string): number {
    const reusable = [...this.#releasedGuestCids].sort((left, right) => left - right)[0];
    const guestCid = reusable ?? this.#nextGuestCid++;
    if (reusable !== undefined) {
      this.#releasedGuestCids.delete(reusable);
    }
    if ([...this.#allocatedGuestCids.values()].includes(guestCid)) {
      throw new CaissonError("SANDBOX_FAILED", "Firecracker guest CID allocation collision");
    }
    this.#allocatedGuestCids.set(sessionId, guestCid);
    return guestCid;
  }

  #releaseGuestCid(sessionId: string): void {
    const guestCid = this.#allocatedGuestCids.get(sessionId);
    if (guestCid !== undefined) {
      this.#allocatedGuestCids.delete(sessionId);
      this.#releasedGuestCids.add(guestCid);
    }
  }

  #safePathSegment(value: string): string {
    return value.replaceAll(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48);
  }
}
