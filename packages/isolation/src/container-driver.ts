import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CaissonError, type DriverCapabilities } from "@caisson/protocol";

import { runCommand } from "./process.js";
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

const DEFAULT_WORKSPACE_SIZE_MIB = 64;
const DEFAULT_MAX_CONCURRENT = 50;

export interface ContainerDriverOptions {
  readonly dockerPath?: string;
  readonly maxConcurrent?: number;
  readonly warn?: (message: string) => void;
  readonly hostId?: string;
  readonly transportDirectory?: string;
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
  readonly #hostId: string;
  readonly #transportDirectory: string;

  constructor(options: ContainerDriverOptions = {}) {
    this.#dockerPath = options.dockerPath ?? "docker";
    this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.#hostId = options.hostId ?? "local";
    this.#transportDirectory =
      options.transportDirectory ?? join(tmpdir(), "caisson-broker-sockets");
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

  async prepare(spec: SandboxSpec, transportHost: TransportHost): Promise<PreparedSandbox> {
    if (this.#containers.size >= this.#maxConcurrent) {
      throw new CaissonError("SANDBOX_FAILED", "container driver concurrency limit reached");
    }

    const name = `caisson-${spec.id.replaceAll(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48)}`;
    await mkdir(this.#transportDirectory, { mode: 0o700, recursive: true });
    await chmod(this.#transportDirectory, 0o700);
    const transport: TransportDescriptor = {
      kind: "unix",
      hostId: this.#hostId,
      peerIdentifier: join(this.#transportDirectory, `${randomUUID()}.sock`),
    };
    const attachment = await transportHost.reserve(transport);
    if (
      attachment.descriptor.kind !== transport.kind ||
      attachment.descriptor.hostId !== transport.hostId ||
      attachment.descriptor.peerIdentifier !== transport.peerIdentifier ||
      attachment.endpointPath !== transport.peerIdentifier
    ) {
      throw new CaissonError("SANDBOX_FAILED", "container transport attachment is invalid");
    }
    try {
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
        "--mount",
        `type=bind,src=${attachment.endpointPath},dst=/run/caisson-broker.sock`,
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
    } catch (error: unknown) {
      await transportHost.release(transport);
      throw error;
    }

    this.#containers.set(spec.id, { name });
    return { handle: { id: spec.id, driver: "container" }, transport };
  }

  async start(handle: SandboxHandle): Promise<void> {
    const container = this.#getContainer(handle);
    const start = await runCommand(this.#dockerPath, ["start", container.name]);
    if (start.exitCode !== 0) {
      throw new CaissonError("SANDBOX_FAILED", "container sandbox start failed");
    }
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

  async snapshot(_handle: SandboxHandle, _kind: "base" | "session"): Promise<LocalSnapshot> {
    throw new CaissonError("SANDBOX_FAILED", "container driver does not support snapshots");
  }

  async restore(
    _ref: ResolvedSnapshot,
    _spec: SandboxSpec,
    _transportHost: TransportHost,
  ): Promise<PreparedSandbox> {
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
