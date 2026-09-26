import type { SpawnOptions } from "node:child_process";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants, mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { CaissonError, type DriverCapabilities } from "@caisson/protocol";

import { callFirecrackerApi } from "./firecracker-api.js";
import type {
  ExecRequest,
  ExecResult,
  IsolationDriver,
  SandboxHandle,
  SandboxSpec,
  SnapshotRef,
} from "./types.js";
import { CAISSON_INFRA_PROBE_PORT } from "./vsock-infrastructure-probe.js";

const DEFAULT_BOOT_ARGS = "console=ttyS0 reboot=k panic=1 pci=off";
const DEFAULT_MAX_CONCURRENT = 50;

export interface InfrastructureProbe {
  execute(
    handle: SandboxHandle,
    request: ExecRequest,
    context: InfrastructureProbeContext,
  ): Promise<ExecResult>;
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
  readonly vcpuCount?: number;
  readonly memoryMiB?: number;
  readonly maxConcurrent?: number;
  readonly bootArgs?: string;
  readonly infrastructureProbe?: InfrastructureProbe;
}

interface FirecrackerRecord {
  readonly apiSocketPath: string;
  readonly logPath: string;
  readonly process: ChildProcess;
  readonly runtimePath: string;
  readonly vsockPath: string;
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
  readonly #options: Required<Omit<FirecrackerDriverOptions, "infrastructureProbe">> &
    Pick<FirecrackerDriverOptions, "infrastructureProbe">;
  readonly #records = new Map<string, FirecrackerRecord>();

  constructor(options: FirecrackerDriverOptions) {
    this.#options = {
      ...options,
      guestCidStart: options.guestCidStart ?? 10_000,
      vcpuCount: options.vcpuCount ?? 1,
      memoryMiB: options.memoryMiB ?? 512,
      maxConcurrent: options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      bootArgs: options.bootArgs ?? DEFAULT_BOOT_ARGS,
    };
  }

  capabilities(): DriverCapabilities {
    return {
      hardwareIsolation: true,
      snapshotSupport: true,
      maxConcurrent: this.#options.maxConcurrent,
    };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.#assertProductionRootfs();
    await this.#assertHostRequirements();
    if (this.#records.size >= this.#options.maxConcurrent) {
      throw new CaissonError("SANDBOX_FAILED", "Firecracker driver concurrency limit reached");
    }

    const record = await this.#startProcess(spec.id);
    try {
      await callFirecrackerApi(record.apiSocketPath, "PUT", "/machine-config", {
        vcpu_count: this.#options.vcpuCount,
        mem_size_mib: this.#options.memoryMiB,
        smt: false,
      });
      await callFirecrackerApi(record.apiSocketPath, "PUT", "/boot-source", {
        kernel_image_path: this.#options.kernelImagePath,
        boot_args: this.#options.bootArgs,
      });
      await callFirecrackerApi(record.apiSocketPath, "PUT", "/drives/rootfs", {
        drive_id: "rootfs",
        path_on_host: this.#options.rootfsPath,
        is_root_device: true,
        is_read_only: true,
      });
      await callFirecrackerApi(record.apiSocketPath, "PUT", "/vsock", {
        guest_cid: this.#guestCidFor(spec.id),
        uds_path: record.vsockPath,
      });
      await callFirecrackerApi(record.apiSocketPath, "PUT", "/actions", {
        action_type: "InstanceStart",
      });
      this.#records.set(spec.id, record);
      return { id: spec.id, driver: "firecracker" };
    } catch (error: unknown) {
      await this.#stopProcess(record);
      throw error;
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

  async snapshot(handle: SandboxHandle, kind: "base" | "session"): Promise<SnapshotRef> {
    const record = this.#getRecord(handle);
    const id = randomUUID();
    await mkdir(this.#options.snapshotDirectory, { recursive: true });
    const statePath = join(this.#options.snapshotDirectory, `${id}.state`);
    const memoryPath = join(this.#options.snapshotDirectory, `${id}.memory`);

    await callFirecrackerApi(record.apiSocketPath, "PATCH", "/vm", { state: "Paused" });
    try {
      await callFirecrackerApi(record.apiSocketPath, "PUT", "/snapshot/create", {
        snapshot_type: "Full",
        snapshot_path: statePath,
        mem_file_path: memoryPath,
      });
    } finally {
      await callFirecrackerApi(record.apiSocketPath, "PATCH", "/vm", { state: "Resumed" });
    }

    return {
      id,
      kind,
      statePath,
      memoryPath,
      rootfsPath: this.#options.rootfsPath,
      createdAt: new Date().toISOString(),
    };
  }

  async restore(ref: SnapshotRef, spec: SandboxSpec): Promise<SandboxHandle> {
    this.#assertProductionRootfs();
    await this.#assertHostRequirements();
    const record = await this.#startProcess(spec.id);
    try {
      await callFirecrackerApi(record.apiSocketPath, "PUT", "/snapshot/load", {
        snapshot_path: ref.statePath,
        mem_file_path: ref.memoryPath,
        resume_vm: true,
        vsock_override: { uds_path: record.vsockPath },
      });
      this.#records.set(spec.id, record);
      return { id: spec.id, driver: "firecracker" };
    } catch (error: unknown) {
      await this.#stopProcess(record);
      throw error;
    }
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const record = this.#getRecord(handle);
    this.#records.delete(handle.id);
    await this.#stopProcess(record);
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
    if (
      environment === "production" &&
      basename(this.#options.rootfsPath) === "m1-dev-probe-rootfs.ext4"
    ) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "production refuses the M-1 development probe rootfs",
      );
    }
  }

  async #startProcess(sessionId: string): Promise<FirecrackerRecord> {
    const runtimePath = join(this.#options.runtimeDirectory, this.#safePathSegment(sessionId));
    const apiSocketPath = join(runtimePath, "firecracker.sock");
    const vsockPath = join(runtimePath, "vsock.sock");
    const logPath = join(runtimePath, "firecracker.log");
    await mkdir(runtimePath, { recursive: true });
    const logFile = await open(logPath, "a");
    let process: ChildProcess;
    try {
      process = spawn(
        this.#options.firecrackerPath,
        ["--api-sock", apiSocketPath],
        firecrackerProcessSpawnOptions(logFile.fd),
      );
    } finally {
      await logFile.close();
    }
    await this.#waitForApiSocket(process, apiSocketPath);
    return { apiSocketPath, logPath, process, runtimePath, vsockPath };
  }

  async #stopProcess(record: FirecrackerRecord): Promise<void> {
    if (!record.process.killed) {
      record.process.kill("SIGKILL");
    }
    await rm(record.runtimePath, { force: true, recursive: true });
  }

  async #waitForApiSocket(process: ChildProcess, apiSocketPath: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
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

  #guestCidFor(sessionId: string): number {
    let sum = 0;
    for (const character of sessionId) {
      sum = (sum + character.charCodeAt(0)) % 50_000;
    }
    return this.#options.guestCidStart + sum;
  }

  #safePathSegment(value: string): string {
    return value.replaceAll(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48);
  }
}
