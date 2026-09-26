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
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, request: ExecRequest): Promise<ExecResult>;
  snapshot(handle: SandboxHandle, kind: "base" | "session"): Promise<SnapshotRef>;
  restore(ref: SnapshotRef, spec: SandboxSpec): Promise<SandboxHandle>;
  destroy(handle: SandboxHandle): Promise<void>;
  capabilities(): DriverCapabilities;
}
