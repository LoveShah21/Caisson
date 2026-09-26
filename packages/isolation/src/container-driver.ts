import { CaissonError, type DriverCapabilities } from "@caisson/protocol";

import { runCommand } from "./process.js";
import type {
  ExecRequest,
  ExecResult,
  IsolationDriver,
  SandboxHandle,
  SandboxSpec,
  SnapshotRef,
} from "./types.js";

const DEFAULT_WORKSPACE_SIZE_MIB = 64;
const DEFAULT_MAX_CONCURRENT = 50;

export interface ContainerDriverOptions {
  readonly dockerPath?: string;
  readonly maxConcurrent?: number;
  readonly warn?: (message: string) => void;
}

interface ContainerRecord {
  readonly name: string;
}

/**
 * Development-only driver. It shares the host kernel and is never hardware isolation.
 */
export class ContainerDriver implements IsolationDriver {
  readonly #dockerPath: string;
  readonly #maxConcurrent: number;
  readonly #containers = new Map<string, ContainerRecord>();

  constructor(options: ContainerDriverOptions = {}) {
    this.#dockerPath = options.dockerPath ?? "docker";
    this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    (options.warn ?? console.warn)(
      "Caisson is using the container isolation driver. It does not provide hardware isolation.",
    );
  }

  capabilities(): DriverCapabilities {
    return {
      hardwareIsolation: false,
      snapshotSupport: false,
      maxConcurrent: this.#maxConcurrent,
    };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (this.#containers.size >= this.#maxConcurrent) {
      throw new CaissonError("SANDBOX_FAILED", "container driver concurrency limit reached");
    }

    const name = `caisson-${spec.id.replaceAll(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48)}`;
    const workspaceSizeMiB = spec.workspaceSizeMiB ?? DEFAULT_WORKSPACE_SIZE_MIB;
    const create = await runCommand(this.#dockerPath, [
      "create",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--workdir",
      "/workspace",
      "--tmpfs",
      `/workspace:rw,noexec,nosuid,nodev,size=${workspaceSizeMiB}m`,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16m",
      spec.image,
      "sleep",
      "infinity",
    ]);
    if (create.exitCode !== 0) {
      throw new CaissonError("SANDBOX_FAILED", "container sandbox creation failed");
    }

    const start = await runCommand(this.#dockerPath, ["start", name]);
    if (start.exitCode !== 0) {
      await runCommand(this.#dockerPath, ["rm", "-f", name]);
      throw new CaissonError("SANDBOX_FAILED", "container sandbox start failed");
    }

    this.#containers.set(spec.id, { name });
    return { id: spec.id, driver: "container" };
  }

  async exec(handle: SandboxHandle, request: ExecRequest): Promise<ExecResult> {
    const container = this.#getContainer(handle);
    if (request.argv.length === 0) {
      throw new CaissonError(
        "INVALID_REQUEST",
        "infrastructure exec requires a non-empty argv array",
      );
    }

    const args = ["exec"];
    if (request.cwd !== undefined) {
      args.push("--workdir", request.cwd);
    }
    args.push(container.name, ...request.argv);
    return runCommand(this.#dockerPath, args, request.timeoutMs);
  }

  async snapshot(_handle: SandboxHandle, _kind: "base" | "session"): Promise<SnapshotRef> {
    throw new CaissonError("SANDBOX_FAILED", "container driver does not support snapshots");
  }

  async restore(_ref: SnapshotRef, _spec: SandboxSpec): Promise<SandboxHandle> {
    throw new CaissonError("SANDBOX_FAILED", "container driver does not support snapshot restore");
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const container = this.#containers.get(handle.id);
    if (container === undefined) {
      return;
    }
    const removal = await runCommand(this.#dockerPath, ["rm", "-f", container.name]);
    this.#containers.delete(handle.id);
    if (removal.exitCode !== 0) {
      throw new CaissonError("SANDBOX_FAILED", "container sandbox destruction failed");
    }
  }

  #getContainer(handle: SandboxHandle): ContainerRecord {
    if (handle.driver !== "container") {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "container driver received a foreign sandbox handle",
      );
    }
    const container = this.#containers.get(handle.id);
    if (container === undefined) {
      throw new CaissonError("SESSION_NOT_FOUND", "sandbox handle is no longer active");
    }
    return container;
  }
}
