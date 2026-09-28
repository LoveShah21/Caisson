import type { AuditOutboxWriter } from "@caisson/audit";
import type {
  IsolationDriver,
  PreparedSandbox,
  SandboxHandle,
  TransportDescriptor,
  TransportHost,
} from "@caisson/isolation";
import {
  CaissonError,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type DeleteSessionResponse,
  type GetSessionResponse,
  type SessionFailureReason,
  type SessionStatus,
} from "@caisson/protocol";
import type { Sql } from "postgres";

import { createSessionTokenRecord, uuidV7 } from "./session-identity.js";

const DEFAULT_START_TIMEOUT_MS = 30_000;

interface SessionRow {
  readonly id: string;
  readonly status: SessionStatus;
  readonly agent_image: string;
  readonly entrypoint: string;
  readonly scopes: string[];
  readonly requested_by: string;
  readonly purpose: string | null;
  readonly policy_bundle_id: string;
  readonly driver: "container" | "firecracker" | null;
  readonly hardware_isolated: boolean;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly last_activity_at: Date;
  readonly failure_reason: SessionFailureReason | null;
  readonly action_allow_count: number;
  readonly action_deny_count: number;
  readonly action_require_approval_count: number;
}

interface BoundTransportRow {
  readonly host_id: string;
  readonly transport_kind: "unix" | "vsock";
  readonly peer_identifier: string;
}

interface PreparedRuntime {
  readonly handle: SandboxHandle;
  readonly transport: TransportDescriptor;
}

export interface SessionLifecycleOptions {
  readonly sql: Sql;
  readonly driver: IsolationDriver;
  readonly transportHost: TransportHost;
  readonly audit: AuditOutboxWriter;
  readonly websocketBaseUrl: string;
  readonly startTimeoutMs?: number;
  readonly now?: () => Date;
}

export class SessionLifecycleService {
  readonly #sql: Sql;
  readonly #driver: IsolationDriver;
  readonly #transportHost: TransportHost;
  readonly #audit: AuditOutboxWriter;
  readonly #websocketBaseUrl: string;
  readonly #startTimeoutMs: number;
  readonly #now: () => Date;
  readonly #prepared = new Map<string, PreparedRuntime>();
  readonly #startup = new Map<string, Promise<void>>();
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: SessionLifecycleOptions) {
    this.#sql = options.sql;
    this.#driver = options.driver;
    this.#transportHost = options.transportHost;
    this.#audit = options.audit;
    this.#websocketBaseUrl = options.websocketBaseUrl.replace(/\/$/, "");
    this.#startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date());
  }

  async create(request: CreateSessionRequest): Promise<CreateSessionResponse> {
    const sessionId = uuidV7();
    const expiresAt = new Date(this.#now().getTime() + request.ttlSeconds * 1_000);
    const policyBundleId = await this.#resolvePolicyBundle(request.policyBundleId);
    const token = await createSessionTokenRecord();
    const prepared = await this.#driver.prepare(
      { id: sessionId, image: request.agent.image, entrypoint: request.agent.entrypoint },
      this.#transportHost,
    );

    try {
      await this.#sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO sessions (
            id, status, agent_image, entrypoint, approval_mode, scopes, policy_bundle_id,
            requested_by, purpose, metadata, host_id, driver, hardware_isolated,
            expires_at, idle_timeout_s
          ) VALUES (
            ${sessionId}, 'booting', ${request.agent.image}, ${request.agent.entrypoint},
            ${request.approvalMode}, ${[...request.scopes]}, ${policyBundleId},
            ${request.requestedBy}, ${request.purpose ?? null}, ${transaction.json(request.metadata)}::jsonb,
            ${prepared.transport.hostId}, ${prepared.handle.driver},
            ${this.#driver.capabilities().hardwareIsolation}, ${expiresAt}, ${request.idleTimeoutSeconds}
          )
        `;
        await transaction`
          INSERT INTO session_tokens (id, session_id, token_hash, scopes, expires_at)
          VALUES (${token.id}, ${sessionId}, ${token.tokenHash}, ${[...request.scopes]}, ${expiresAt})
        `;
        await transaction`
          INSERT INTO transport_bindings (
            id, session_id, host_id, transport_kind, peer_identifier, token_id
          ) VALUES (
            ${uuidV7()}, ${sessionId}, ${prepared.transport.hostId}, ${prepared.transport.kind},
            ${prepared.transport.peerIdentifier}, ${token.id}
          )
        `;
        await this.#audit.enqueueInTransaction(
          transaction,
          lifecycleAuditInput({
            sessionId,
            action: "create",
            driver: prepared.handle.driver,
            hardwareIsolated: this.#driver.capabilities().hardwareIsolation,
            intent: request.purpose ?? null,
          }),
        );
      });
    } catch (error: unknown) {
      await this.#destroyAndRelease(prepared);
      throw error;
    }

    this.#prepared.set(sessionId, prepared);
    const startup = this.#start(sessionId, prepared);
    this.#startup.set(sessionId, startup);
    void startup.catch(() => undefined);

    return {
      sessionId,
      status: "booting",
      driver: prepared.handle.driver,
      hardwareIsolated: this.#driver.capabilities().hardwareIsolation,
      expiresAt: expiresAt.toISOString(),
      websocketUrl: `${this.#websocketBaseUrl}/v1/sessions/${sessionId}/events`,
    };
  }

  async get(sessionId: string): Promise<GetSessionResponse> {
    const session = await this.#getSession(sessionId);
    return {
      sessionId: session.id,
      status: session.status,
      scopes: session.scopes,
      driver: session.driver,
      hardwareIsolated: session.hardware_isolated,
      intent: session.purpose,
      requestedBy: session.requested_by,
      policyBundleId: session.policy_bundle_id,
      createdAt: session.created_at.toISOString(),
      expiresAt: session.expires_at.toISOString(),
      lastActivityAt: session.last_activity_at.toISOString(),
      failureReason: session.failure_reason,
      actionCounts: {
        allow: session.action_allow_count,
        deny: session.action_deny_count,
        requireApproval: session.action_require_approval_count,
      },
      pendingApprovals: 0,
    };
  }

  async destroy(sessionId: string, reason: string): Promise<DeleteSessionResponse> {
    return this.#withSessionLock(sessionId, async () => {
      const session = await this.#getSession(sessionId);
      if (isTerminal(session.status)) {
        return { sessionId, status: session.status };
      }

      const revoked = await this.#tryRevokeToken(sessionId, "terminated");
      const runtime = await this.#runtimeFor(session);
      const destroyed = await this.#tryDestroy(runtime.handle);
      if (!revoked || !destroyed) {
        await this.#markFailed(session, "cleanup_pending", "destroy_failed");
        return { sessionId, status: "failed" };
      }
      const released = await this.#tryRelease(sessionId, runtime.transport);
      if (!released) {
        await this.#markFailed(session, "cleanup_pending", "release_failed");
        return { sessionId, status: "failed" };
      }

      await this.#markTerminated(session, reason);
      this.#prepared.delete(sessionId);
      return { sessionId, status: "terminated" };
    });
  }

  async reconcileBooting(): Promise<void> {
    const cutoff = new Date(this.#now().getTime() - this.#startTimeoutMs);
    const sessions = await this.#sql<SessionRow[]>`
      SELECT id, status, agent_image, entrypoint, scopes, requested_by, purpose,
             policy_bundle_id, driver, hardware_isolated, created_at, expires_at,
             last_activity_at, failure_reason, action_allow_count, action_deny_count,
             action_require_approval_count
      FROM sessions
      WHERE status = 'booting' AND created_at <= ${cutoff}
    `;
    await Promise.all(
      sessions.map((session) =>
        this.#withReconciliationLock(session.id, () =>
          this.#withSessionLock(session.id, async () => {
            const current = await this.#getSession(session.id);
            if (current.status === "booting") {
              await this.#failStart(current, "start_timeout", "boot_timeout");
            }
          }),
        ),
      ),
    );
  }

  async reconcileCleanup(): Promise<void> {
    const sessions = await this.#sql<SessionRow[]>`
      SELECT id, status, agent_image, entrypoint, scopes, requested_by, purpose,
             policy_bundle_id, driver, hardware_isolated, created_at, expires_at,
             last_activity_at, failure_reason, action_allow_count, action_deny_count,
             action_require_approval_count
      FROM sessions
      WHERE status = 'failed' AND failure_reason = 'cleanup_pending'
    `;
    await Promise.all(
      sessions.map((session) =>
        this.#withReconciliationLock(session.id, () =>
          this.#withSessionLock(session.id, async () => {
            const current = await this.#getSession(session.id);
            if (current.status !== "failed" || current.failure_reason !== "cleanup_pending") {
              return;
            }
            const runtime = await this.#runtimeFor(current);
            const revoked = await this.#tryRevokeToken(current.id, "failed");
            const destroyed = await this.#tryDestroy(runtime.handle);
            if (
              !revoked ||
              !destroyed ||
              !(await this.#tryRelease(current.id, runtime.transport))
            ) {
              return;
            }
            await this.#sql`
              UPDATE sessions SET failure_reason = NULL WHERE id = ${current.id} AND status = 'failed'
            `;
            this.#prepared.delete(current.id);
          }),
        ),
      ),
    );
  }

  async reconcile(): Promise<void> {
    await this.reconcileBooting();
    await this.reconcileCleanup();
  }

  async waitForStartup(sessionId: string): Promise<void> {
    await this.#startup.get(sessionId);
  }

  async #start(sessionId: string, runtime: PreparedRuntime): Promise<void> {
    const shouldStart = await this.#withSessionLock(sessionId, async () => {
      const session = await this.#getSession(sessionId);
      return session.status === "booting";
    });
    if (!shouldStart) return;
    try {
      await withTimeout(this.#driver.start(runtime.handle), this.#startTimeoutMs);
      await this.#withSessionLock(sessionId, async () => {
        const session = await this.#getSession(sessionId);
        if (session.status === "booting") await this.#markReady(session);
      });
    } catch (error: unknown) {
      const reason: SessionFailureReason =
        error instanceof StartTimeoutError ? "start_timeout" : "driver_error";
      await this.#withSessionLock(sessionId, async () => {
        const session = await this.#getSession(sessionId);
        if (session.status === "booting") await this.#failStart(session, reason, "start_failed");
      });
    }
  }

  async #failStart(
    session: SessionRow,
    reason: SessionFailureReason,
    auditMethod: string,
  ): Promise<void> {
    const revoked = await this.#tryRevokeToken(session.id, "failed");
    const runtime = await this.#runtimeFor(session);
    const destroyed = await this.#tryDestroy(runtime.handle);
    if (!revoked || !destroyed) {
      await this.#markFailed(session, "cleanup_pending", auditMethod);
      return;
    }
    if (!(await this.#tryRelease(session.id, runtime.transport))) {
      await this.#markFailed(session, "cleanup_pending", auditMethod);
      return;
    }
    await this.#markFailed(session, reason, auditMethod);
    this.#prepared.delete(session.id);
  }

  async #markReady(session: SessionRow): Promise<void> {
    await this.#sql.begin(async (transaction) => {
      const result = await transaction`
        UPDATE sessions SET status = 'ready' WHERE id = ${session.id} AND status = 'booting'
      `;
      if (result.count === 0) {
        return;
      }
      await this.#audit.enqueueInTransaction(
        transaction,
        lifecycleAuditInput({
          sessionId: session.id,
          action: "ready",
          driver: requireDriver(session.driver),
          hardwareIsolated: session.hardware_isolated,
          intent: session.purpose,
        }),
      );
    });
  }

  async #markFailed(
    session: SessionRow,
    reason: SessionFailureReason,
    auditMethod: string,
  ): Promise<void> {
    await this.#sql.begin(async (transaction) => {
      const result = await transaction`
        UPDATE sessions
        SET status = 'failed', failure_reason = ${reason}, terminated_at = now(), termination_reason = ${reason}
        WHERE id = ${session.id} AND status IN ('pending', 'booting', 'ready', 'active', 'suspended')
      `;
      if (result.count === 0) {
        return;
      }
      await this.#audit.enqueueInTransaction(
        transaction,
        lifecycleAuditInput({
          sessionId: session.id,
          action: auditMethod,
          driver: requireDriver(session.driver),
          hardwareIsolated: session.hardware_isolated,
          intent: session.purpose,
          errorCode: reason,
        }),
      );
    });
  }

  async #markTerminated(session: SessionRow, reason: string): Promise<void> {
    await this.#sql.begin(async (transaction) => {
      await transaction`
        UPDATE sessions SET status = 'terminating'
        WHERE id = ${session.id} AND status IN ('pending', 'booting', 'ready', 'active', 'suspended')
      `;
      const result = await transaction`
        UPDATE sessions
        SET status = 'terminated', terminated_at = now(), termination_reason = ${reason}
        WHERE id = ${session.id} AND status = 'terminating'
      `;
      if (result.count === 0) {
        return;
      }
      await this.#audit.enqueueInTransaction(
        transaction,
        lifecycleAuditInput({
          sessionId: session.id,
          action: "destroy",
          driver: requireDriver(session.driver),
          hardwareIsolated: session.hardware_isolated,
          intent: session.purpose,
        }),
      );
    });
  }

  async #tryRevokeToken(sessionId: string, reason: string): Promise<boolean> {
    try {
      await this.#sql`
        UPDATE session_tokens
        SET revoked_at = now(), revocation_reason = ${reason}
        WHERE session_id = ${sessionId} AND revoked_at IS NULL
      `;
      return true;
    } catch {
      return false;
    }
  }

  async #runtimeFor(session: SessionRow): Promise<PreparedRuntime> {
    const live = this.#prepared.get(session.id);
    if (live !== undefined) {
      return live;
    }
    const [binding] = await this.#sql<BoundTransportRow[]>`
      SELECT host_id, transport_kind, peer_identifier
      FROM transport_bindings
      WHERE session_id = ${session.id} AND released_at IS NULL
      ORDER BY bound_at DESC LIMIT 1
    `;
    if (binding === undefined) {
      throw new CaissonError("SANDBOX_FAILED", "sandbox transport binding is unavailable");
    }
    return {
      handle: { id: session.id, driver: requireDriver(session.driver) },
      transport: {
        hostId: binding.host_id,
        kind: binding.transport_kind,
        peerIdentifier: binding.peer_identifier,
      },
    };
  }

  async #getSession(sessionId: string): Promise<SessionRow> {
    const [session] = await this.#sql<SessionRow[]>`
      SELECT id, status, agent_image, entrypoint, scopes, requested_by, purpose,
             policy_bundle_id, driver, hardware_isolated, created_at, expires_at,
             last_activity_at, failure_reason, action_allow_count, action_deny_count,
             action_require_approval_count
      FROM sessions WHERE id = ${sessionId}
    `;
    if (session === undefined) {
      throw new CaissonError("SESSION_NOT_FOUND", "session not found");
    }
    return session;
  }

  async #resolvePolicyBundle(requested: string | undefined): Promise<string> {
    const policyBundleId = requested ?? (await this.#activePolicyBundleId());
    const [bundle] = await this.#sql<{ id: string }[]>`
      SELECT id FROM policy_bundles WHERE id = ${policyBundleId} AND retired_at IS NULL
    `;
    if (bundle === undefined) {
      throw new CaissonError("POLICY_UNAVAILABLE", "requested policy bundle is unavailable");
    }
    return bundle.id;
  }

  async #activePolicyBundleId(): Promise<string> {
    const [setting] = await this.#sql<{ value: unknown }[]>`
      SELECT value FROM settings WHERE key = 'active_policy_bundle'
    `;
    const value = setting?.value;
    if (
      value === null ||
      typeof value !== "object" ||
      !("policyBundleId" in value) ||
      typeof value.policyBundleId !== "string"
    ) {
      throw new CaissonError("POLICY_UNAVAILABLE", "no active policy bundle is configured");
    }
    return value.policyBundleId;
  }

  async #tryDestroy(handle: SandboxHandle): Promise<boolean> {
    try {
      await this.#driver.destroy(handle);
      return true;
    } catch {
      return false;
    }
  }

  async #tryRelease(sessionId: string, transport: TransportDescriptor): Promise<boolean> {
    try {
      await this.#transportHost.release(transport);
      await this.#sql`
        UPDATE transport_bindings SET released_at = now()
        WHERE session_id = ${sessionId} AND released_at IS NULL
      `;
      return true;
    } catch {
      return false;
    }
  }

  async #destroyAndRelease(prepared: PreparedSandbox): Promise<void> {
    await this.#driver.destroy(prepared.handle);
    await this.#transportHost.release(prepared.transport);
  }

  async #withReconciliationLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const result = await this.#sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}, 0))`;
      return work();
    });
    return result as T;
  }

  async #withSessionLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(sessionId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    this.#locks.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release?.();
      if (this.#locks.get(sessionId) === tail) {
        this.#locks.delete(sessionId);
      }
    }
  }
}

class StartTimeoutError extends Error {}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new StartTimeoutError("sandbox start timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function lifecycleAuditInput(input: {
  readonly sessionId: string;
  readonly action: string;
  readonly driver: "container" | "firecracker";
  readonly hardwareIsolated: boolean;
  readonly intent: string | null;
  readonly errorCode?: string;
}) {
  return {
    sessionId: input.sessionId,
    actionId: uuidV7(),
    eventType: "lifecycle",
    actionType: "lifecycle",
    method: input.action,
    decision: "n/a",
    paramsHash: "0".repeat(64),
    paramsPreview: `status=${input.action}`,
    agentIntent: input.intent ?? "",
    driver: input.driver,
    hardwareIsolated: input.hardwareIsolated,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  };
}

function requireDriver(driver: SessionRow["driver"]): "container" | "firecracker" {
  if (driver === null) {
    throw new CaissonError("SANDBOX_FAILED", "session driver is unavailable");
  }
  return driver;
}

function isTerminal(status: SessionStatus): status is "terminated" | "failed" {
  return status === "terminated" || status === "failed";
}
