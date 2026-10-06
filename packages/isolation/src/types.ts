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

/** Host-derived durable suspension point, never guest-provided. */
export interface SessionResumeContext {
  readonly lastAuditSeq: number;
  readonly lastActionId: string;
  readonly resumedAt: string;
}

export interface StartOptions {
  /** Required for a mid-session restore before the guest may become ready. */
  readonly resume?: SessionResumeContext;
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

export interface SnapshotObjectRef {
  readonly bucket: string;
  readonly key: string;
  readonly versionId?: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Immutable, remotely stored snapshot manifest. */
export interface SnapshotRef {
  readonly id: string;
  readonly kind: "base" | "session";
  readonly manifest: SnapshotObjectRef;
  readonly manifestKeyId: string;
  readonly createdAt: string;
  /** Session snapshots are restoreable only by this originating session. */
  readonly sessionId?: string;
  /** Immutable base snapshot that supplies the rootfs/kernel backing path. */
  readonly baseSnapshotId?: string;
}

/** Driver-produced local files, not eligible for persistence until stored and verified. */
export interface LocalSnapshot {
  readonly id: string;
  readonly kind: "base" | "session";
  readonly statePath: string;
  readonly memoryPath: string;
  readonly rootfsPath?: string;
  /** Base-only source artifact, retained in the manifest for reproducibility. */
  readonly kernelPath?: string;
  readonly createdAt: string;
}

/** Verified local cache paths supplied to an isolation driver for restore. */
export interface ResolvedSnapshot {
  readonly ref: SnapshotRef;
  readonly statePath: string;
  readonly memoryPath: string;
  readonly rootfsPath?: string;
  readonly kernelPath?: string;
}

export interface IsolationDriver {
  prepare(spec: SandboxSpec, transportHost: TransportHost): Promise<PreparedSandbox>;
  start(handle: SandboxHandle, options?: StartOptions): Promise<void>;
  exec(handle: SandboxHandle, request: ExecRequest): Promise<ExecResult>;
  snapshot(handle: SandboxHandle, kind: "base" | "session"): Promise<LocalSnapshot>;
  restore(
    ref: ResolvedSnapshot,
    spec: SandboxSpec,
    transportHost: TransportHost,
  ): Promise<PreparedSandbox>;
  destroy(handle: SandboxHandle): Promise<void>;
  capabilities(): DriverCapabilities;
}
