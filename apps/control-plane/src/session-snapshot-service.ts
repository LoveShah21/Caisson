import type {
  IsolationDriver,
  PreparedSandbox,
  ResolvedSnapshot,
  SandboxSpec,
  SnapshotRef,
  TransportHost,
} from "@caisson/isolation";
import { CaissonError } from "@caisson/protocol";
import type { Sql, TransactionSql } from "postgres";
import type { SessionActionGate } from "./session-action-gate.js";
import type {
  SessionSnapshotCrypto,
  WrappedSessionKek,
  WrappedSnapshotDek,
} from "./session-snapshot-crypto.js";

export interface SessionSnapshotRetention {
  readonly durationMs: number;
  readonly count: number;
}

export interface SessionSnapshotServiceOptions {
  readonly sql: Sql;
  readonly driver: IsolationDriver;
  readonly transportHost: TransportHost;
  readonly crypto: SessionSnapshotCrypto;
  readonly store: SessionSnapshotStore;
  readonly baseStore: BaseSnapshotResolver;
  /** ADR-19 binding persistence, after restore/prepare and before start/resume. */
  readonly bindRestoredTransport: (sessionId: string, prepared: PreparedSandbox) => Promise<void>;
  readonly actionGate: SessionActionGate;
  readonly captureDrainTimeoutMs: number;
  readonly retention: SessionSnapshotRetention;
  readonly now?: () => Date;
}

export interface SessionSnapshotStore {
  store(
    local: Awaited<ReturnType<IsolationDriver["snapshot"]>>,
    input: {
      sessionId: string;
      baseSnapshotId: string;
      sessionKek: WrappedSessionKek;
      snapshotDek: WrappedSnapshotDek;
    },
  ): Promise<SnapshotRef>;
  resolve(
    ref: SnapshotRef,
    input: {
      sessionId: string;
      sessionKek: WrappedSessionKek;
      snapshotDek: WrappedSnapshotDek;
      base: ResolvedSnapshot;
    },
  ): Promise<ResolvedSnapshot>;
  deleteObjects(ref: SnapshotRef): Promise<void>;
}

export interface BaseSnapshotResolver {
  resolve(ref: SnapshotRef): Promise<ResolvedSnapshot>;
  release(ref: SnapshotRef): Promise<void>;
}

interface SessionKeyRow {
  readonly root_kek_key_id: string;
  readonly wrap_nonce: Buffer;
  readonly wrapped_session_kek: Buffer;
}

interface SnapshotKeyRow {
  readonly wrap_nonce: Buffer;
  readonly wrapped_dek: Buffer;
}

/** FR-16 persistence, retention erasure, and FR-17b truthful resume orchestration. */
export class SessionSnapshotService {
  readonly #sql: Sql;
  readonly #driver: IsolationDriver;
  readonly #transportHost: TransportHost;
  readonly #crypto: SessionSnapshotCrypto;
  readonly #store: SessionSnapshotStore;
  readonly #baseStore: BaseSnapshotResolver;
  readonly #bindRestoredTransport: SessionSnapshotServiceOptions["bindRestoredTransport"];
  readonly #actionGate: SessionActionGate;
  readonly #captureDrainTimeoutMs: number;
  readonly #retention: SessionSnapshotRetention;
  readonly #now: () => Date;

  constructor(options: SessionSnapshotServiceOptions) {
    if (!Number.isSafeInteger(options.retention.durationMs) || options.retention.durationMs <= 0) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "session snapshot retention duration configuration is invalid",
      );
    }
    if (!Number.isSafeInteger(options.retention.count) || options.retention.count <= 0) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "session snapshot retention count configuration is invalid",
      );
    }
    if (
      !Number.isSafeInteger(options.captureDrainTimeoutMs) ||
      options.captureDrainTimeoutMs <= 0
    ) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "session snapshot action-drain timeout configuration is invalid",
      );
    }
    this.#sql = options.sql;
    this.#driver = options.driver;
    this.#transportHost = options.transportHost;
    this.#crypto = options.crypto;
    this.#store = options.store;
    this.#baseStore = options.baseStore;
    this.#bindRestoredTransport = options.bindRestoredTransport;
    this.#actionGate = options.actionGate;
    this.#captureDrainTimeoutMs = options.captureDrainTimeoutMs;
    this.#retention = options.retention;
    this.#now = options.now ?? (() => new Date());
  }

  static retentionFromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
  ): SessionSnapshotRetention {
    // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv is index-signature-only under strict TS.
    const duration = environment["CAISSON_SESSION_SNAPSHOT_RETENTION_MS"];
    // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv is index-signature-only under strict TS.
    const count = environment["CAISSON_SESSION_SNAPSHOT_RETENTION_COUNT"];
    const durationMs = duration === undefined ? Number.NaN : Number.parseInt(duration, 10);
    const retained = count === undefined ? Number.NaN : Number.parseInt(count, 10);
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 ||
      !Number.isSafeInteger(retained) ||
      retained <= 0
    ) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "session snapshot retention configuration is missing or invalid",
      );
    }
    return { durationMs, count: retained };
  }

  static captureDrainTimeoutFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
    // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv is index-signature-only under strict TS.
    const raw = environment["CAISSON_SESSION_SNAPSHOT_DRAIN_TIMEOUT_MS"];
    const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "session snapshot action-drain timeout configuration is missing or invalid",
      );
    }
    return value;
  }

  /** Called in the same session-creation transaction after the session row exists. */
  async provisionSessionKey(transaction: Sql | TransactionSql, sessionId: string): Promise<void> {
    const sessionKek = await this.#crypto.createWrappedSessionKek();
    await transaction`
      INSERT INTO session_snapshot_keys (session_id, root_kek_key_id, wrap_nonce, wrapped_session_kek)
      VALUES (${sessionId}, ${sessionKek.keyId}, ${sessionKek.nonce}, ${sessionKek.ciphertext})
    `;
  }

  async capture(
    sessionId: string,
    prepared: PreparedSandbox,
    baseSnapshotId: string,
  ): Promise<SnapshotRef> {
    const ref = await this.#actionGate.withExclusiveCapture(
      sessionId,
      this.#captureDrainTimeoutMs,
      async () => {
        const suspension = await this.#latestDurableAction(sessionId);
        const sessionKek = await this.#sessionKek(sessionId);
        const snapshotDek = await this.#crypto.createWrappedSnapshotDek(sessionKek);
        const local = await this.#driver.snapshot(prepared.handle, "session");
        const stored = await this.#store.store(local, {
          sessionId,
          baseSnapshotId,
          sessionKek,
          snapshotDek,
        });
        try {
          await this.#sql.begin(async (transaction) => {
            await transaction`
              INSERT INTO snapshots (
                id, kind, session_id, lineage_session_id, base_snapshot_id, bucket,
                manifest_key, manifest_version, manifest_sha256, manifest_size_bytes,
                manifest_key_id, built_at, expires_at, resume_audit_seq, resume_action_id
              ) VALUES (
                ${stored.id}, 'session', ${sessionId}, ${sessionId}, ${baseSnapshotId}, ${stored.manifest.bucket},
                ${stored.manifest.key}, ${stored.manifest.versionId ?? null}, ${stored.manifest.sha256},
                ${stored.manifest.sizeBytes}, ${stored.manifestKeyId}, ${new Date(stored.createdAt)},
                ${new Date(this.#now().getTime() + this.#retention.durationMs)},
                ${suspension.lastAuditSeq}, ${suspension.lastActionId}
              )
            `;
            await transaction`
              INSERT INTO snapshot_keys (snapshot_id, session_id, wrap_nonce, wrapped_dek)
              VALUES (${stored.id}, ${sessionId}, ${snapshotDek.nonce}, ${snapshotDek.ciphertext})
            `;
          });
        } catch (error: unknown) {
          await this.#store.deleteObjects(stored).catch(() => undefined);
          throw error;
        }
        return stored;
      },
    );
    await this.prune(sessionId);
    return ref;
  }

  async restore(ref: SnapshotRef, sessionId: string, spec: SandboxSpec): Promise<PreparedSandbox> {
    if (ref.kind !== "session" || ref.sessionId !== sessionId || ref.baseSnapshotId === undefined) {
      throw new CaissonError("SANDBOX_FAILED", "session snapshot restore lineage is invalid");
    }
    const [stored] = await this.#sql<SnapshotDatabaseRow[]>`
      SELECT id, kind, session_id, base_snapshot_id, bucket, manifest_key, manifest_version,
             manifest_sha256, manifest_size_bytes, manifest_key_id, built_at,
             resume_audit_seq, resume_action_id
      FROM snapshots
      WHERE id = ${ref.id} AND kind = 'session' AND session_id = ${sessionId}
        AND deletion_state = 'active'
    `;
    if (
      stored === undefined ||
      stored.base_snapshot_id !== ref.baseSnapshotId ||
      stored.resume_audit_seq === null ||
      stored.resume_action_id === null
    ) {
      throw new CaissonError("SANDBOX_FAILED", "session snapshot suspension point is unavailable");
    }
    const storedRef = toSnapshotRef(stored);
    const [base] = await this.#sql<SnapshotDatabaseRow[]>`
      SELECT id, kind, session_id, base_snapshot_id, bucket, manifest_key, manifest_version,
             manifest_sha256, manifest_size_bytes, manifest_key_id, built_at
      FROM snapshots WHERE id = ${ref.baseSnapshotId} AND kind = 'base'
    `;
    if (base === undefined)
      throw new CaissonError("SANDBOX_FAILED", "session snapshot base is unavailable");
    const resolvedBase = await this.#baseStore.resolve(toSnapshotRef(base));
    const resolved = await this.#store.resolve(storedRef, {
      sessionId,
      sessionKek: await this.#sessionKek(sessionId),
      snapshotDek: await this.#snapshotDek(storedRef.id, sessionId),
      base: resolvedBase,
    });
    const prepared = await this.#driver.restore(resolved, spec, this.#transportHost);
    const resume = {
      lastAuditSeq: stored.resume_audit_seq,
      lastActionId: stored.resume_action_id,
      resumedAt: this.#now().toISOString(),
    };
    try {
      await this.#bindRestoredTransport(sessionId, prepared);
      await this.#driver.start(prepared.handle, { resume });
      return prepared;
    } catch (error: unknown) {
      await this.#driver.destroy(prepared.handle);
      await this.#transportHost.release(prepared.transport);
      throw error;
    } finally {
      await this.#baseStore.release(resolvedBase.ref);
    }
  }

  /** Cryptographically erases expired/excess snapshot data before object deletion retries. */
  async prune(sessionId: string): Promise<void> {
    const cutoff = new Date(this.#now().getTime() - this.#retention.durationMs);
    const snapshots = await this.#sql<SnapshotDatabaseRow[]>`
      SELECT id, kind, session_id, base_snapshot_id, bucket, manifest_key, manifest_version,
             manifest_sha256, manifest_size_bytes, manifest_key_id, built_at
      FROM snapshots
      WHERE session_id = ${sessionId} AND kind = 'session' AND deletion_state = 'active'
      ORDER BY built_at DESC
    `;
    const expired = snapshots.filter(
      (snapshot, index) => snapshot.built_at < cutoff || index >= this.#retention.count,
    );
    for (const snapshot of expired) await this.#eraseSnapshot(snapshot, sessionId);
  }

  /** Preferred teardown: delete the session KEK wrapper, then queue every physical deletion. */
  async eraseSession(sessionId: string): Promise<void> {
    await this.#sql.begin(async (transaction) => {
      await transaction`DELETE FROM session_snapshot_keys WHERE session_id = ${sessionId}`;
      const snapshots = await transaction<SnapshotDatabaseRow[]>`
        SELECT id, kind, session_id, base_snapshot_id, bucket, manifest_key, manifest_version,
               manifest_sha256, manifest_size_bytes, manifest_key_id, built_at
        FROM snapshots WHERE session_id = ${sessionId} AND kind = 'session' AND deletion_state = 'active'
      `;
      for (const snapshot of snapshots) {
        await transaction`UPDATE snapshots SET deletion_state = 'crypto_erased' WHERE id = ${snapshot.id}`;
        await transaction`
          INSERT INTO snapshot_deletion_outbox (snapshot_id, session_id, bucket, manifest_key)
          VALUES (${snapshot.id}, ${sessionId}, ${snapshot.bucket}, ${snapshot.manifest_key})
          ON CONFLICT (snapshot_id) DO NOTHING
        `;
      }
    });
  }

  async retryPhysicalDeletion(): Promise<void> {
    const rows = await this.#sql<
      { snapshot_id: string; session_id: string; bucket: string; manifest_key: string }[]
    >`
      SELECT snapshot_id, session_id, bucket, manifest_key
      FROM snapshot_deletion_outbox WHERE completed_at IS NULL
      ORDER BY created_at FOR UPDATE SKIP LOCKED
    `;
    for (const row of rows) {
      try {
        const [snapshot] = await this.#sql<SnapshotDatabaseRow[]>`
          SELECT id, kind, session_id, base_snapshot_id, bucket, manifest_key, manifest_version,
                 manifest_sha256, manifest_size_bytes, manifest_key_id, built_at
          FROM snapshots WHERE id = ${row.snapshot_id}
        `;
        if (snapshot !== undefined) await this.#store.deleteObjects(toSnapshotRef(snapshot));
        await this
          .#sql`UPDATE snapshot_deletion_outbox SET completed_at = now(), last_error = NULL WHERE snapshot_id = ${row.snapshot_id}`;
        await this
          .#sql`UPDATE snapshots SET deletion_state = 'physically_deleted' WHERE id = ${row.snapshot_id}`;
      } catch {
        await this
          .#sql`UPDATE snapshot_deletion_outbox SET attempts = attempts + 1, last_error = 'physical deletion failed' WHERE snapshot_id = ${row.snapshot_id}`;
      }
    }
  }

  async #eraseSnapshot(snapshot: SnapshotDatabaseRow, sessionId: string): Promise<void> {
    await this.#sql.begin(async (transaction) => {
      await transaction`DELETE FROM snapshot_keys WHERE snapshot_id = ${snapshot.id} AND session_id = ${sessionId}`;
      await transaction`UPDATE snapshots SET deletion_state = 'crypto_erased' WHERE id = ${snapshot.id} AND deletion_state = 'active'`;
      await transaction`
        INSERT INTO snapshot_deletion_outbox (snapshot_id, session_id, bucket, manifest_key)
        VALUES (${snapshot.id}, ${sessionId}, ${snapshot.bucket}, ${snapshot.manifest_key})
        ON CONFLICT (snapshot_id) DO NOTHING
      `;
    });
  }

  async #sessionKek(sessionId: string): Promise<WrappedSessionKek> {
    const [row] = await this.#sql<SessionKeyRow[]>`
      SELECT root_kek_key_id, wrap_nonce, wrapped_session_kek
      FROM session_snapshot_keys WHERE session_id = ${sessionId}
    `;
    if (row === undefined)
      throw new CaissonError("SANDBOX_FAILED", "session snapshot key has been erased");
    return {
      keyId: row.root_kek_key_id,
      nonce: Buffer.from(row.wrap_nonce),
      ciphertext: Buffer.from(row.wrapped_session_kek),
    };
  }

  async #snapshotDek(snapshotId: string, sessionId: string): Promise<WrappedSnapshotDek> {
    const [row] = await this.#sql<SnapshotKeyRow[]>`
      SELECT wrap_nonce, wrapped_dek FROM snapshot_keys
      WHERE snapshot_id = ${snapshotId} AND session_id = ${sessionId}
    `;
    if (row === undefined)
      throw new CaissonError("SANDBOX_FAILED", "session snapshot key has been erased");
    return { nonce: Buffer.from(row.wrap_nonce), ciphertext: Buffer.from(row.wrapped_dek) };
  }

  async #latestDurableAction(
    sessionId: string,
  ): Promise<{ lastAuditSeq: number; lastActionId: string; resumedAt: string }> {
    const [row] = await this.#sql<{ seq: number; payload: { actionId?: unknown } }[]>`
      SELECT seq, payload FROM audit_outbox WHERE session_id = ${sessionId}
      ORDER BY seq DESC LIMIT 1
    `;
    if (row === undefined || typeof row.payload.actionId !== "string") {
      throw new CaissonError("AUDIT_UNAVAILABLE", "durable suspension point is unavailable");
    }
    return {
      lastAuditSeq: row.seq,
      lastActionId: row.payload.actionId,
      resumedAt: this.#now().toISOString(),
    };
  }
}

interface SnapshotDatabaseRow {
  readonly id: string;
  readonly kind: "base" | "session";
  readonly session_id: string | null;
  readonly base_snapshot_id: string | null;
  readonly bucket: string;
  readonly manifest_key: string;
  readonly manifest_version: string | null;
  readonly manifest_sha256: string;
  readonly manifest_size_bytes: string | number;
  readonly manifest_key_id: string;
  readonly built_at: Date;
  readonly resume_audit_seq: number | null;
  readonly resume_action_id: string | null;
}

function toSnapshotRef(row: SnapshotDatabaseRow): SnapshotRef {
  return {
    id: row.id,
    kind: row.kind,
    manifest: {
      bucket: row.bucket,
      key: row.manifest_key,
      ...(row.manifest_version === null ? {} : { versionId: row.manifest_version }),
      sha256: row.manifest_sha256,
      sizeBytes: Number(row.manifest_size_bytes),
    },
    manifestKeyId: row.manifest_key_id,
    createdAt: row.built_at.toISOString(),
    ...(row.kind === "session" && row.session_id !== null && row.base_snapshot_id !== null
      ? { sessionId: row.session_id, baseSnapshotId: row.base_snapshot_id }
      : {}),
  };
}
