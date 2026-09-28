import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AuditOutboxWriter,
  type AuditSink,
  type StoredAuditEvent,
} from "../../packages/audit/src/index.js";
import { SessionLifecycleService } from "../../apps/control-plane/src/session-lifecycle.js";
import { createControlPlaneServer } from "../../apps/control-plane/src/server.js";
import type {
  IsolationDriver,
  SandboxHandle,
  TransportDescriptor,
  TransportHost,
} from "../../packages/isolation/src/index.js";
import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

const bundleId = "018f0000-0000-7000-8000-000000000201";

describe("single-session lifecycle", () => {
  let postgres: PostgresFixture;

  beforeAll(async () => {
    postgres = await createPostgresFixture();
    await postgres.sql`
      INSERT INTO policy_bundles (id, version, rego_source, wasm_blob, source_hash, created_by)
      VALUES (${bundleId}, 'lifecycle-test', 'package caisson', ${Buffer.from([0])}, 'lifecycle-test', 'test')
    `;
    await postgres.sql`
      INSERT INTO settings (key, value) VALUES ('active_policy_bundle', ${{ policyBundleId: bundleId }}::jsonb)
    `;
  }, 30_000);

  afterAll(async () => postgres?.close());

  it("commits session, token, binding, and create audit seq 1 before async start", async () => {
    const driver = new ControlledDriver();
    const host = new ControlledHost();
    const service = makeService(postgres, driver, host);
    const created = await service.create(request());

    expect(created.status).toBe("booting");
    const [state] = await postgres.sql<{ status: string; next_audit_seq: number }[]>`
      SELECT status, next_audit_seq FROM sessions WHERE id = ${created.sessionId}
    `;
    const [audit] = await postgres.sql<{ seq: number }[]>`
      SELECT seq FROM audit_outbox WHERE session_id = ${created.sessionId}
    `;
    expect(state).toEqual({ status: "booting", next_audit_seq: 1 });
    expect(audit?.seq).toBe(1);

    driver.resolveStart();
    await service.waitForStartup(created.sessionId);
    expect((await service.get(created.sessionId)).status).toBe("ready");
  });

  it("retains binding when destroy fails and releases it after reconciliation", async () => {
    const driver = new ControlledDriver();
    const host = new ControlledHost();
    const service = makeService(postgres, driver, host);
    const created = await service.create(request());
    driver.rejectStart();
    driver.failDestroy = true;
    await service.waitForStartup(created.sessionId);

    expect((await service.get(created.sessionId)).failureReason).toBe("cleanup_pending");
    expect(host.releases).toHaveLength(0);
    driver.failDestroy = false;
    await service.reconcileCleanup();
    expect(host.releases).toHaveLength(1);
    const [binding] = await postgres.sql<{ released_at: Date | null }[]>`
      SELECT released_at FROM transport_bindings WHERE session_id = ${created.sessionId}
    `;
    expect(binding?.released_at).not.toBeNull();
  });

  it("destroys despite revocation failure, then reconciles revocation before release", async () => {
    const driver = new ControlledDriver();
    const host = new ControlledHost();
    const service = makeService(postgres, driver, host);
    const created = await service.create(request());
    await postgres.sql.unsafe(`
      CREATE OR REPLACE FUNCTION fail_token_revocation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected token revocation failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_token_revocation BEFORE UPDATE OF revoked_at ON session_tokens
      FOR EACH ROW EXECUTE FUNCTION fail_token_revocation();
    `);
    try {
      driver.rejectStart();
      await service.waitForStartup(created.sessionId);

      expect(driver.destroyCalls).toBe(1);
      expect((await service.get(created.sessionId)).failureReason).toBe("cleanup_pending");
      expect(host.releases).toHaveLength(0);
      const [before] = await postgres.sql<{ revoked_at: Date | null; released_at: Date | null }[]>`
        SELECT token.revoked_at, binding.released_at
        FROM session_tokens token
        JOIN transport_bindings binding ON binding.token_id = token.id
        WHERE token.session_id = ${created.sessionId}
      `;
      expect(before).toEqual({ revoked_at: null, released_at: null });

      await postgres.sql.unsafe(
        "DROP TRIGGER fail_token_revocation ON session_tokens; DROP FUNCTION fail_token_revocation();",
      );
      await service.reconcileCleanup();
      const [after] = await postgres.sql<{ revoked_at: Date | null; released_at: Date | null }[]>`
        SELECT token.revoked_at, binding.released_at
        FROM session_tokens token
        JOIN transport_bindings binding ON binding.token_id = token.id
        WHERE token.session_id = ${created.sessionId}
      `;
      expect(after?.revoked_at).not.toBeNull();
      expect(after?.released_at).not.toBeNull();
    } finally {
      await postgres.sql.unsafe(
        "DROP TRIGGER IF EXISTS fail_token_revocation ON session_tokens; DROP FUNCTION IF EXISTS fail_token_revocation();",
      );
    }
  });

  it("retains a transport identity after release failure until reconciliation succeeds", async () => {
    const driver = new ControlledDriver();
    const host = new ControlledHost();
    host.failRelease = true;
    const service = makeService(postgres, driver, host);
    const created = await service.create(request());
    driver.rejectStart();
    await service.waitForStartup(created.sessionId);

    const descriptor: TransportDescriptor = {
      kind: "unix",
      hostId: "test-host",
      peerIdentifier: `socket-${created.sessionId}`,
    };
    expect((await service.get(created.sessionId)).failureReason).toBe("cleanup_pending");
    await expect(host.reserve(descriptor)).rejects.toThrow("already reserved");

    host.failRelease = false;
    await service.reconcileCleanup();
    expect(driver.destroyCalls).toBe(2);
    expect(host.releases).toHaveLength(1);
    await service.reconcileCleanup();
    expect(host.releases).toHaveLength(1);
    await expect(host.reserve(descriptor)).resolves.toMatchObject({ descriptor });
  });

  it("moves an old booting session to failed during reconciliation", async () => {
    const driver = new ControlledDriver();
    const host = new ControlledHost();
    const service = makeService(postgres, driver, host);
    const created = await service.create(request());
    await postgres.sql`
      UPDATE sessions SET created_at = now() - INTERVAL '1 minute' WHERE id = ${created.sessionId}
    `;
    await service.reconcileBooting();
    expect((await service.get(created.sessionId)).status).toBe("failed");
  });

  it("uses a database advisory lock so two reconcilers process a stale session once", async () => {
    const driver = new ControlledDriver();
    const host = new ControlledHost();
    const first = makeService(postgres, driver, host);
    const second = makeService(postgres, driver, host);
    const created = await first.create(request());
    await postgres.sql`
      UPDATE sessions SET created_at = now() - INTERVAL '1 minute' WHERE id = ${created.sessionId}
    `;

    await Promise.all([first.reconcileBooting(), second.reconcileBooting()]);
    expect(driver.destroyCalls).toBe(1);
    expect((await first.get(created.sessionId)).status).toBe("failed");
  });

  it("serializes concurrent durable audit allocations and decision counters", async () => {
    const driver = new ControlledDriver();
    const service = makeService(postgres, driver, new ControlledHost());
    const created = await service.create(request());
    driver.resolveStart();
    await service.waitForStartup(created.sessionId);
    const audit = new AuditOutboxWriter(postgres.sql, new NoopSink());
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        audit.persistDurably({
          sessionId: created.sessionId,
          actionId: `018f0000-0000-7000-8000-${String(300 + index).padStart(12, "0")}`,
          eventType: "observed",
          actionType: "lifecycle",
          decision: index % 2 === 0 ? "allow" : "deny",
          driver: "container",
          hardwareIsolated: false,
        }),
      ),
    );
    const state = await service.get(created.sessionId);
    expect(state.actionCounts).toEqual({ allow: 6, deny: 6, requireApproval: 0 });
    const [sequences] = await postgres.sql<{ count: string; max: number }[]>`
      SELECT count(*)::text AS count, max(seq) AS max FROM audit_outbox WHERE session_id = ${created.sessionId}
    `;
    expect(sequences).toEqual({ count: "14", max: 14 });
  });

  it("converges a concurrent delete and failing start on one terminal state with ordered audit events", async () => {
    const driver = new ControlledDriver();
    const service = makeService(postgres, driver, new ControlledHost());
    const created = await service.create(request());
    const deletion = service.destroy(created.sessionId, "operator_request");
    driver.rejectStart();
    const deleted = await deletion;
    await service.waitForStartup(created.sessionId);

    expect(["terminated", "failed"]).toContain(deleted.status);
    expect((await service.get(created.sessionId)).status).toBe(deleted.status);
    const rows = await postgres.sql<{ seq: number }[]>`
      SELECT seq FROM audit_outbox WHERE session_id = ${created.sessionId} ORDER BY seq
    `;
    expect(rows.map((row) => row.seq)).toEqual([...new Set(rows.map((row) => row.seq))]);
    expect(rows.map((row) => row.seq)).toEqual(rows.map((_row, index) => index + 1));
  });

  it("serves create, get, and idempotent delete without exposing transport or token material", async () => {
    const driver = new ControlledDriver();
    const lifecycle = makeService(postgres, driver, new ControlledHost());
    const app = createControlPlaneServer({ lifecycle, reconcileIntervalMs: 60_000 });
    try {
      const created = await app.inject({ method: "POST", url: "/v1/sessions", payload: request() });
      expect(created.statusCode).toBe(201);
      const body = created.json();
      expect(body).not.toHaveProperty("token");
      driver.resolveStart();
      await lifecycle.waitForStartup(body.sessionId);

      const fetched = await app.inject({ method: "GET", url: `/v1/sessions/${body.sessionId}` });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json()).toMatchObject({ status: "ready", intent: "test lifecycle" });
      expect(fetched.json()).not.toHaveProperty("hostId");

      const deleted = await app.inject({
        method: "DELETE",
        url: `/v1/sessions/${body.sessionId}`,
        payload: { reason: "operator_request" },
      });
      expect(deleted.statusCode).toBe(202);
      expect(deleted.json()).toMatchObject({ status: "terminated" });
      const repeat = await app.inject({
        method: "DELETE",
        url: `/v1/sessions/${body.sessionId}`,
        payload: { reason: "operator_request" },
      });
      expect(repeat.json()).toMatchObject({ status: "terminated" });
    } finally {
      await app.close();
    }
  });

  it("starts a single-flight periodic reconciler on boot and stops it without leaked timers", async () => {
    const scheduler = new FakeScheduler();
    const lifecycle = new BlockingLifecycle();
    const app = createControlPlaneServer({
      lifecycle: lifecycle as unknown as SessionLifecycleService,
      reconcileIntervalMs: 10,
      reconciliationScheduler: scheduler,
    });
    await app.ready();
    expect(lifecycle.calls).toBe(1);
    expect(scheduler.size).toBe(1);

    lifecycle.blockNextRun();
    scheduler.fireAll();
    scheduler.fireAll();
    expect(lifecycle.calls).toBe(2);

    const closing = app.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(scheduler.size).toBe(0);
    lifecycle.resolveBlockedRun();
    await closing;
    expect(scheduler.size).toBe(0);
    expect(lifecycle.calls).toBe(2);
  });
});

function makeService(
  fixture: PostgresFixture,
  driver: ControlledDriver,
  host: ControlledHost,
  startTimeoutMs = 1_000,
) {
  return new SessionLifecycleService({
    sql: fixture.sql,
    driver,
    transportHost: host,
    audit: new AuditOutboxWriter(fixture.sql, new NoopSink()),
    websocketBaseUrl: "ws://control-plane.test",
    startTimeoutMs,
  });
}

function request() {
  return {
    agent: { image: "test-image", entrypoint: "default" },
    scopes: ["warehouse.readonly"],
    approvalMode: "rule" as const,
    ttlSeconds: 300,
    idleTimeoutSeconds: 30,
    requestedBy: "test operator",
    purpose: "test lifecycle",
    metadata: {},
  };
}

class NoopSink implements AuditSink {
  async hasEvent(): Promise<boolean> {
    return false;
  }
  async insert(_event: StoredAuditEvent): Promise<void> {}
}

class ControlledHost implements TransportHost {
  readonly releases: TransportDescriptor[] = [];
  failRelease = false;
  readonly #reserved = new Set<string>();
  async reserve(descriptor: TransportDescriptor) {
    if (this.#reserved.has(descriptor.peerIdentifier)) {
      throw new Error("transport peer identifier is already reserved");
    }
    this.#reserved.add(descriptor.peerIdentifier);
    return { descriptor, endpointPath: descriptor.peerIdentifier };
  }
  async release(descriptor: TransportDescriptor): Promise<void> {
    if (this.failRelease) throw new Error("injected release failure");
    this.#reserved.delete(descriptor.peerIdentifier);
    this.releases.push(descriptor);
  }
}

class ControlledDriver implements IsolationDriver {
  failDestroy = false;
  destroyCalls = 0;
  #start: Promise<void>;
  #resolveStart!: () => void;
  #rejectStart!: () => void;
  constructor() {
    this.#start = new Promise<void>((resolve, reject) => {
      this.#resolveStart = resolve;
      this.#rejectStart = () => reject(new Error("start failed"));
    });
    void this.#start.catch(() => undefined);
  }
  capabilities() {
    return { hardwareIsolation: false, snapshotSupport: false, maxConcurrent: 1 };
  }
  async prepare(spec: { id: string }, host: TransportHost) {
    const transport = {
      kind: "unix" as const,
      hostId: "test-host",
      peerIdentifier: `socket-${spec.id}`,
    };
    await host.reserve(transport);
    return { handle: { id: spec.id, driver: "container" as const }, transport };
  }
  async start(): Promise<void> {
    return this.#start;
  }
  resolveStart() {
    this.#resolveStart();
  }
  rejectStart() {
    this.#rejectStart();
  }
  async destroy(_handle: SandboxHandle): Promise<void> {
    this.destroyCalls += 1;
    if (this.failDestroy) throw new Error("destroy failed");
  }
  async exec() {
    throw new Error("not used");
  }
  async snapshot() {
    throw new Error("not used");
  }
  async restore() {
    throw new Error("not used");
  }
}

class FakeScheduler {
  readonly #callbacks = new Map<number, () => void>();
  #nextId = 0;

  get size(): number {
    return this.#callbacks.size;
  }

  setInterval(callback: () => void, _intervalMs: number): ReturnType<typeof setInterval> {
    const id = ++this.#nextId;
    this.#callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof setInterval>;
  }

  clearInterval(handle: ReturnType<typeof setInterval>): void {
    this.#callbacks.delete(handle as unknown as number);
  }

  fireAll(): void {
    for (const callback of this.#callbacks.values()) callback();
  }
}

class BlockingLifecycle {
  calls = 0;
  #block = false;
  #resolve: (() => void) | undefined;

  blockNextRun(): void {
    this.#block = true;
  }

  resolveBlockedRun(): void {
    this.#resolve?.();
  }

  async reconcile(): Promise<void> {
    this.calls += 1;
    if (!this.#block) return;
    this.#block = false;
    await new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
  }
}
