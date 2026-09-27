import type { DriverCapabilities, IsolationDriverName } from "@caisson/protocol";

export interface SandboxSpec {
  readonly id: string;
  readonly image: string;
  readonly entrypoint?: string;
  readonly workspaceSizeMiB?: number;
}

export interface SandboxHandle {
  readonly id: string;
  readonly driver: IsolationDriverName;
}

export interface TransportDescriptor {
  readonly kind: "vsock" | "unix";
  readonly hostId: string;
  readonly peerIdentifier: string;
}

/** Runtime-only endpoint supplied by the host that owns the transport lifecycle. */
export interface TransportAttachment {
  readonly descriptor: TransportDescriptor;
  readonly endpointPath: string;
}

export interface TransportHost {
  /**
   * Reserves the descriptor and returns its runtime endpoint. For a container,
   * this creates the Unix listener. For Firecracker, it reserves the private
   * UDS namespace that the trusted Firecracker process will bind.
   */
  reserve(descriptor: TransportDescriptor): Promise<TransportAttachment>;
  /** Called only after the sandbox using this descriptor has been destroyed. */
  release(descriptor: TransportDescriptor): Promise<void>;
}

export interface PreparedSandbox {
  readonly handle: SandboxHandle;
  readonly transport: TransportDescriptor;
}

export interface ExecRequest {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface SnapshotRef {
  readonly id: string;
  readonly kind: "base" | "session";
  readonly statePath: string;
  readonly memoryPath: string;
  readonly rootfsPath?: string;
  readonly createdAt: string;
}

export interface IsolationDriver {
  prepare(spec: SandboxSpec, transportHost: TransportHost): Promise<PreparedSandbox>;
  start(handle: SandboxHandle): Promise<void>;
  exec(handle: SandboxHandle, request: ExecRequest): Promise<ExecResult>;
  snapshot(handle: SandboxHandle, kind: "base" | "session"): Promise<SnapshotRef>;
  restore(
    ref: SnapshotRef,
    spec: SandboxSpec,
    transportHost: TransportHost,
  ): Promise<PreparedSandbox>;
  destroy(handle: SandboxHandle): Promise<void>;
  capabilities(): DriverCapabilities;
}
