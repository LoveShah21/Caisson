import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AuditOutboxWriter,
  type AuditSink,
  ClickHouseAuditSink,
  type StoredAuditEvent,
} from "../../packages/audit/src/index.js";
import { type ClickHouseFixture, createClickHouseFixture } from "../helpers/clickhouse.js";
import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

const bundleId = "018f0000-0000-7000-8000-000000000101";
const sessionId = "018f0000-0000-7000-8000-000000000102";

describe("Postgres audit outbox", () => {
  let postgres: PostgresFixture;
  let clickhouse: ClickHouseFixture;
  let sink: ClickHouseAuditSink;

  beforeAll(async () => {
    [postgres, clickhouse] = await Promise.all([
      createPostgresFixture(),
      createClickHouseFixture(),
    ]);
    sink = new ClickHouseAuditSink(clickhouse);
    await sink.ensureSchema();
    await postgres.sql`
      INSERT INTO policy_bundles (id, version, rego_source, wasm_blob, source_hash, created_by)
      VALUES (${bundleId}, 'audit-test', 'package caisson', ${Buffer.from([0])}, 'audit-test', 'test')
    `;
    await postgres.sql`
      INSERT INTO sessions (
        id, agent_image, approval_mode, scopes, policy_bundle_id, requested_by,
        hardware_isolated, expires_at
      ) VALUES (
        ${sessionId}, 'test-image', 'rule', ARRAY['warehouse.readonly'], ${bundleId},
        'test operator', false, '2026-12-31T00:00:00Z'
      )
    `;
  }, 60_000);

  afterAll(async () => {
    await Promise.all([postgres?.close(), clickhouse?.close()]);
  });

  it("skips an ambiguous retry after a real ClickHouse insert has landed", async () => {
    const timeoutAfterCommit = new TimeoutAfterCommitSink(sink);
    const writer = new AuditOutboxWriter(postgres.sql, timeoutAfterCommit);
    const input = lifecycleInput("018f0000-0000-7000-8000-000000000103");

    await expect(writer.persistBeforeExecution(input)).rejects.toMatchObject({
      code: "AUDIT_UNAVAILABLE",
    });
    await writer.deliverSession(sessionId);

    expect(await clickhouse.query(countQuery(sessionId, 1))).toBe("1\n");
    const [outbox] = await postgres.sql<{ delivery_state: string; delivery_attempts: number }[]>`
      SELECT delivery_state, delivery_attempts FROM audit_outbox
      WHERE session_id = ${sessionId} AND seq = 1
    `;
    expect(outbox).toMatchObject({ delivery_state: "delivered" });
    expect(outbox?.delivery_attempts).toBeGreaterThanOrEqual(2);
  });

  it("serializes concurrent deliverers for one session", async () => {
    const writer = new AuditOutboxWriter(postgres.sql, sink);
    await writer.persistDurably(lifecycleInput("018f0000-0000-7000-8000-000000000104"));

    await Promise.all([writer.deliverSession(sessionId), writer.deliverSession(sessionId)]);

    expect(await clickhouse.query(countQuery(sessionId, 2))).toBe("1\n");
  });

  it("drains pending terminal records during startup or periodic recovery", async () => {
    const writer = new AuditOutboxWriter(postgres.sql, sink);
    await writer.persistDurably(lifecycleInput("018f0000-0000-7000-8000-000000000108"));

    await writer.drainPending();

    expect(await clickhouse.query(countQuery(sessionId, 3))).toBe("1\n");
  });

  it("inserts a first delivery without a redundant existence lookup", async () => {
    const writer = new AuditOutboxWriter(postgres.sql, new FirstDeliverySink(sink));

    await writer.persistBeforeExecution(lifecycleInput("018f0000-0000-7000-8000-000000000109"));

    expect(await clickhouse.query(countQuery(sessionId, 4))).toBe("1\n");
  });

  it("rejects raw parameter, credential, secret, and result payload fields in Postgres", async () => {
    await expect(
      postgres.sql`
        INSERT INTO audit_outbox (id, session_id, seq, payload)
        VALUES (
          '018f0000-0000-7000-8000-000000000105',
          ${sessionId},
          999,
          ${{ params: { password: "plausible-secret-value" } }}::jsonb
        )
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        INSERT INTO audit_outbox (id, session_id, seq, payload)
        VALUES (
          '018f0000-0000-7000-8000-000000000106',
          ${sessionId},
          1000,
          ${{ credentials: "plausible-secret-value" }}::jsonb
        )
      `,
    ).rejects.toThrow();
    await expect(
      postgres.sql`
        INSERT INTO audit_outbox (id, session_id, seq, payload)
        VALUES (
          '018f0000-0000-7000-8000-000000000107',
          ${sessionId},
          1001,
          ${{ result: "raw-result-body" }}::jsonb
        )
      `,
    ).rejects.toThrow();
  });

  it("proves the pinned ClickHouse supports finite non-replicated token deduplication", async () => {
    await clickhouse.query(`
      CREATE TABLE audit_dedup_probe (
        session_id UUID,
        seq UInt32
      ) ENGINE = MergeTree
      ORDER BY (session_id, seq)
      SETTINGS non_replicated_deduplication_window = 100
    `);
    try {
      await clickhouse.query(`
        INSERT INTO audit_dedup_probe SETTINGS insert_deduplication_token = 'audit-dedup-probe'
        VALUES ('${sessionId}', 1)
      `);
      await clickhouse.query(`
        INSERT INTO audit_dedup_probe SETTINGS insert_deduplication_token = 'audit-dedup-probe'
        VALUES ('${sessionId}', 1)
      `);
      expect(
        await clickhouse.query("SELECT count() FROM audit_dedup_probe FORMAT TabSeparated"),
      ).toBe("1\n");
    } finally {
      await clickhouse.query("DROP TABLE audit_dedup_probe");
    }
  });
});

class TimeoutAfterCommitSink implements AuditSink {
  readonly #sink: AuditSink;
  #hasTimedOut = false;

  constructor(sink: AuditSink) {
    this.#sink = sink;
  }

  async hasEvent(sessionId: string, seq: number): Promise<boolean> {
    return this.#sink.hasEvent(sessionId, seq);
  }

  async insert(event: StoredAuditEvent): Promise<void> {
    await this.#sink.insert(event);
    if (!this.#hasTimedOut) {
      this.#hasTimedOut = true;
      throw new Error("simulated client timeout after ClickHouse committed the insert");
    }
  }
}

class FirstDeliverySink implements AuditSink {
  readonly #sink: AuditSink;

  constructor(sink: AuditSink) {
    this.#sink = sink;
  }

  async hasEvent(): Promise<boolean> {
    throw new Error("first delivery must not query ClickHouse for an existing event");
  }

  async insert(event: StoredAuditEvent): Promise<void> {
    await this.#sink.insert(event);
  }
}

function lifecycleInput(actionId: string) {
  return {
    sessionId,
    actionId,
    eventType: "lifecycle",
    actionType: "lifecycle",
    method: "create",
    decision: "n/a",
    paramsHash: "0".repeat(64),
    paramsPreview: "status=booting",
    agentIntent: "create isolated session",
    driver: "container" as const,
    hardwareIsolated: false,
  };
}

function countQuery(id: string, seq: number): string {
  return `SELECT count() FROM actions WHERE session_id = '${id}' AND seq = ${seq} FORMAT TabSeparated`;
}
