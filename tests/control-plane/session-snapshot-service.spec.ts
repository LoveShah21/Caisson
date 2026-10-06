import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SessionActionGate } from "../../apps/control-plane/src/session-action-gate.js";
import { SessionSnapshotCrypto } from "../../apps/control-plane/src/session-snapshot-crypto.js";
import {
  type SessionSnapshotStore,
  SessionSnapshotService,
} from "../../apps/control-plane/src/session-snapshot-service.js";
import type {
  IsolationDriver,
  LocalSnapshot,
  PreparedSandbox,
  ResolvedSnapshot,
  SandboxHandle,
  SandboxSpec,
  SnapshotRef,
  TransportHost,
} from "../../packages/isolation/src/index.js";
import { SecretString } from "../../packages/secrets/src/credentials.js";
import type { SecretBackend } from "../../packages/secrets/src/types.js";
import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

const bundleId = "018f0000-0000-7000-8000-000000000a01";
const sessionId = "018f0000-0000-7000-8000-000000000a02";
const baseSnapshotId = "018f0000-0000-7000-8000-000000000a03";
const suspensionActionId = "018f0000-0000-7000-8000-000000000a04";

describe("SessionSnapshotService", () => {
  let postgres: PostgresFixture;

  beforeAll(async () => {
    postgres = await createPostgresFixture();
    await postgres.sql`
      INSERT INTO policy_bundles (id, version, rego_source, wasm_blob, source_hash, created_by)
      VALUES (${bundleId}, 'snapshot-test', 'package caisson', ${Buffer.from([0])}, 'snapshot-test', 'test')
    `;
    await postgres.sql`
      INSERT INTO sessions (
        id, status, agent_image, approval_mode, scopes, roles, policy_bundle_id,
        requested_by, hardware_isolated, driver, expires_at, next_audit_seq
      ) VALUES (
        ${sessionId}, 'active', 'agent-runtime', 'auto', ARRAY['workspace.read'], ARRAY[]::text[],
        ${bundleId}, 'test', true, 'firecracker', '2027-01-01T00:00:00Z', 1
      )
    `;
    await postgres.sql`
      INSERT INTO snapshots (
        id, kind, bucket, manifest_key, manifest_sha256, manifest_size_bytes,
        manifest_key_id, built_at
      ) VALUES (
        ${baseSnapshotId}, 'base', 'snapshots', 'base/manifest.json', ${"a".repeat(64)}, 1,
        'manifest-key', now()
      )
    `;
    await postgres.sql`
      INSERT INTO audit_outbox (id, session_id, seq, payload)
      VALUES (
        ${randomUUID()}, ${sessionId}, 1,
        ${{ actionId: suspensionActionId, eventType: "action.completed" }}::jsonb
      )
    `;
  }, 30_000);

  afterAll(async () => postgres?.close());

  it("drains an in-flight action and holds admission through snapshot DEK and suspension-point commit", async () => {
    const gate = new SessionActionGate();
    const driver = new SnapshotDriver();
    const store = new BlockingSnapshotStore(sessionId, baseSnapshotId);
    const service = makeService(gate, driver, store, 1_000);
    await service.provisionSessionKey(postgres.sql, sessionId);
    const inFlight = gate.enter(sessionId);
    expect(inFlight).toBeDefined();

    const captured = service.capture(sessionId, prepared(), baseSnapshotId);
    expect(gate.enter(sessionId)).toBeUndefined();
    expect(driver.snapshot).not.toHaveBeenCalled();

    inFlight?.release();
    await store.waitUntilStoreStarted();
    expect(driver.snapshot).toHaveBeenCalledTimes(1);
    expect(gate.enter(sessionId)).toBeUndefined();
    const [beforeCommit] = await postgres.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM snapshots WHERE session_id = ${sessionId}
    `;
    expect(beforeCommit?.count).toBe("0");

    store.releaseStore();
    const ref = await captured;
    const [committed] = await postgres.sql<
      { resume_audit_seq: number; resume_action_id: string; key_count: string }[]
    >`
      SELECT snapshot.resume_audit_seq, snapshot.resume_action_id,
             count(snapshot_key.snapshot_id)::text AS key_count
      FROM snapshots AS snapshot
      JOIN snapshot_keys AS snapshot_key ON snapshot_key.snapshot_id = snapshot.id
      WHERE snapshot.id = ${ref.id}
      GROUP BY snapshot.resume_audit_seq, snapshot.resume_action_id
    `;
    expect(committed).toEqual({
      resume_audit_seq: 1,
      resume_action_id: suspensionActionId,
      key_count: "1",
    });
    await expect(
      service.restore(ref, "018f0000-0000-7000-8000-000000000aff", {
        id: randomUUID(),
        image: "agent-runtime",
      }),
    ).rejects.toThrow("session snapshot restore lineage is invalid");

    await service.eraseSession(sessionId);
    const [erasure] = await postgres.sql<
      { session_key_count: string; snapshot_key_count: string; deletion_state: string }[]
    >`
      SELECT
        (SELECT count(*)::text FROM session_snapshot_keys WHERE session_id = ${sessionId}) AS session_key_count,
        (SELECT count(*)::text FROM snapshot_keys WHERE session_id = ${sessionId}) AS snapshot_key_count,
        deletion_state
      FROM snapshots WHERE id = ${ref.id}
    `;
    expect(erasure).toEqual({
      session_key_count: "0",
      snapshot_key_count: "1",
      deletion_state: "crypto_erased",
    });
    const after = gate.enter(sessionId);
    expect(after).toBeDefined();
    after?.release();
  });

  it("aborts a timed-out drain without driver capture or restorable metadata", async () => {
    const gate = new SessionActionGate();
    const driver = new SnapshotDriver();
    const store = new BlockingSnapshotStore(sessionId, baseSnapshotId);
    store.releaseStore();
    const service = makeService(gate, driver, store, 10);
    const inFlight = gate.enter(sessionId);

    await expect(service.capture(sessionId, prepared(), baseSnapshotId)).rejects.toMatchObject({
      code: "SANDBOX_FAILED",
    });
    expect(driver.snapshot).not.toHaveBeenCalled();
    inFlight?.release();
  });

  function makeService(
    gate: SessionActionGate,
    driver: SnapshotDriver,
    store: BlockingSnapshotStore,
    captureDrainTimeoutMs: number,
  ): SessionSnapshotService {
    return new SessionSnapshotService({
      sql: postgres.sql,
      driver,
      transportHost: {} as TransportHost,
      crypto: new SessionSnapshotCrypto(
        new SnapshotKeyBackend(randomBytes(32).toString("base64")),
        { backend: "env", backendPath: "TEST_SNAPSHOT_KEK", role: "snapshot-kek" },
      ),
      store,
      baseStore: {
        resolve: async () => {
          throw new Error("restore is not used by capture tests");
        },
        release: async () => undefined,
      },
      bindRestoredTransport: async () => undefined,
      actionGate: gate,
      captureDrainTimeoutMs,
      retention: { count: 10, durationMs: 60_000 },
    });
  }
});

class SnapshotDriver implements IsolationDriver {
  readonly snapshot = vi.fn(
    async (): Promise<LocalSnapshot> => ({
      id: randomUUID(),
      kind: "session",
      statePath: "state",
      memoryPath: "memory",
      createdAt: new Date().toISOString(),
    }),
  );

  async prepare(): Promise<PreparedSandbox> {
    throw new Error("not used");
  }
  async start(): Promise<void> {}
  async exec(): Promise<never> {
    throw new Error("not used");
  }
  async restore(): Promise<PreparedSandbox> {
    throw new Error("not used");
  }
  async destroy(): Promise<void> {}
  capabilities() {
    return { hardwareIsolation: true, snapshotSupport: true, maxConcurrent: 1 };
  }
}

class BlockingSnapshotStore implements SessionSnapshotStore {
  readonly #sessionId: string;
  readonly #baseSnapshotId: string;
  #startedResolve!: () => void;
  readonly #started = new Promise<void>((resolve) => (this.#startedResolve = resolve));
  #storeResolve!: () => void;
  readonly #store = new Promise<void>((resolve) => (this.#storeResolve = resolve));

  constructor(sessionId: string, baseSnapshotId: string) {
    this.#sessionId = sessionId;
    this.#baseSnapshotId = baseSnapshotId;
  }

  async store(local: LocalSnapshot): Promise<SnapshotRef> {
    this.#startedResolve();
    await this.#store;
    return {
      id: local.id,
      kind: "session",
      manifest: {
        bucket: "snapshots",
        key: `session/${local.id}/manifest.json`,
        sha256: "b".repeat(64),
        sizeBytes: 1,
      },
      manifestKeyId: "manifest-key",
      createdAt: local.createdAt,
      sessionId: this.#sessionId,
      baseSnapshotId: this.#baseSnapshotId,
    };
  }

  waitUntilStoreStarted(): Promise<void> {
    return this.#started;
  }

  releaseStore(): void {
    this.#storeResolve();
  }

  async resolve(): Promise<ResolvedSnapshot> {
    throw new Error("not used");
  }

  async deleteObjects(): Promise<void> {}
}

class SnapshotKeyBackend implements SecretBackend {
  readonly #key: string;
  constructor(key: string) {
    this.#key = key;
  }
  async fetch() {
    return {
      kind: "snapshot_kek" as const,
      keyId: "test-root-kek",
      key: new SecretString(this.#key),
    };
  }
  async health(): Promise<boolean> {
    return true;
  }
}

function prepared(): PreparedSandbox {
  return {
    handle: { id: randomUUID(), driver: "firecracker" },
    transport: { kind: "vsock", hostId: "host", peerIdentifier: "42" },
  };
}
