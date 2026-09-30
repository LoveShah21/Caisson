import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrokerAdapter,
  BrokerPipeline,
  DatabaseBrokerServiceResolver,
  FramedBrokerServer,
  PostgresAdapter,
} from "../../apps/broker/src/index.js";
import {
  SessionIdentityResolver,
  SessionTokenService,
} from "../../apps/control-plane/src/index.js";
import {
  AuditOutboxWriter,
  type AuditSink,
  ClickHouseAuditSink,
  type StoredAuditEvent,
} from "../../packages/audit/src/index.js";
import { PolicyBundleLoader } from "../../packages/policy/src/index.js";
import { encodeBrokerFrame } from "../../packages/protocol/src/index.js";
import { EnvSecretBackend } from "../../packages/secrets/src/index.js";
import { initializeTelemetry } from "../../packages/telemetry/src/index.js";

import { type ClickHouseFixture, createClickHouseFixture } from "../helpers/clickhouse.js";
import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

const sessionId = "018f0000-0000-7000-8000-000000000501";
const hostPeer = {
  hostId: "pipeline-host",
  transportKind: "unix" as const,
  peerIdentifier: "pipeline-peer",
};
const canary = "pipeline-canary-85f3b4f9-3c05-4f4b-a3ff-699907d1ba8f";

describe("BrokerPipeline", () => {
  let postgres: PostgresFixture;
  let clickhouse: ClickHouseFixture;
  let adapter: PostgresAdapter;
  let audit: AuditOutboxWriter;
  let pipeline: BrokerPipeline;

  beforeAll(async () => {
    [postgres, clickhouse] = await Promise.all([
      createPostgresFixture(),
      createClickHouseFixture(),
    ]);
    const sink = new ClickHouseAuditSink(clickhouse);
    await sink.ensureSchema();
    bootstrap(postgres.url, "bootstrap-policy.mjs");
    bootstrap(postgres.url, "bootstrap-services.mjs");
    const [active] = await postgres.sql<{ value: { policyBundleId: string } }[]>`
      SELECT value FROM settings WHERE key = 'active_policy_bundle'
    `;
    if (active === undefined) throw new Error("active policy bundle was not bootstrapped");
    await postgres.sql.unsafe(`CREATE ROLE caisson_reader LOGIN PASSWORD '${canary}'`);
    await postgres.sql.unsafe("CREATE TABLE pipeline_probe (value text NOT NULL)");
    await postgres.sql.unsafe("INSERT INTO pipeline_probe (value) VALUES ('safe-result')");
    await postgres.sql.unsafe("GRANT SELECT ON pipeline_probe TO caisson_reader");
    await postgres.sql`
      INSERT INTO sessions (
        id, status, agent_image, approval_mode, scopes, roles, policy_bundle_id,
        requested_by, hardware_isolated, driver, expires_at
      ) VALUES (
        ${sessionId}, 'ready', 'pipeline-test', 'auto', ARRAY['warehouse.readonly'],
        ARRAY['analyst'], ${active.value.policyBundleId}, 'test operator', false, 'container',
        '2026-12-31T00:00:00Z'
      )
    `;
    const tokens = new SessionTokenService(postgres.sql);
    const identities = new SessionIdentityResolver(postgres.sql);
    const token = await tokens.mint({
      sessionId,
      scopes: ["warehouse.readonly"],
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });
    await identities.bind({ sessionId, tokenId: token.id, ...hostPeer });
    adapter = new PostgresAdapter({
      statementTimeoutMs: 1_000,
      rowLimit: 10,
      resultSizeBytes: 1_024,
    });
    audit = new AuditOutboxWriter(postgres.sql, sink);
    initializeTelemetry();
    pipeline = new BrokerPipeline({
      identities,
      services: new DatabaseBrokerServiceResolver(postgres.sql, [adapter]),
      policyBundles: new PolicyBundleLoader(postgres.sql),
      secrets: new EnvSecretBackend({
        environment: {
          CAISSON_POSTGRES_CREDENTIALS: JSON.stringify({
            kind: "postgres",
            host: new URL(postgres.url).hostname,
            port: Number(new URL(postgres.url).port),
            database: "caisson",
            username: "caisson",
            password: "caisson-postgres-test-only",
            readCredentials: { username: "caisson_reader", password: canary },
            sslMode: "disable",
          }),
        },
        caissonEnvironment: "development",
      }),
      audit,
    });
  }, 90_000);

  afterAll(async () => {
    await adapter?.close();
    await Promise.all([postgres?.close(), clickhouse?.close()]);
  });

  it("keeps a credential canary out of the framed end-to-end broker path", async () => {
    const endpointPath = pipeName();
    const server = new FramedBrokerServer({
      endpointPath,
      peer: hostPeer,
      readTimeoutMs: 1_000,
      handle: (peer, request) => pipeline.handle(peer, request),
    });
    await server.listen();
    try {
      const response = await exchange(endpointPath, {
        id: "pipeline-1",
        op: "broker.call",
        body: {
          service: "postgres",
          method: "query",
          params: { sql: "SELECT value FROM pipeline_probe" },
          idempotencyKey: "pipeline-1",
          intent: "read the test row",
        },
      });
      await audit.drainPending();
      const [outbox] = await postgres.sql<{ payload: unknown }[]>`
        SELECT payload FROM audit_outbox WHERE session_id = ${sessionId} ORDER BY seq DESC LIMIT 1
      `;
      const auditRows = await clickhouse.query(
        `SELECT params_preview, agent_intent, error_message, trace_id, span_id FROM actions WHERE session_id = '${sessionId}' FORMAT JSONEachRow`,
      );
      const observable = [
        JSON.stringify(response),
        JSON.stringify(outbox?.payload),
        auditRows,
      ].join("\n");
      expect(response).toMatchObject({
        ok: true,
        body: { result: { rows: [{ value: "safe-result" }] } },
      });
      expect(observable).not.toContain(canary);
      expect(auditRows).toMatch(/"trace_id":"[0-9a-f]{32}"/i);
      expect(auditRows).toMatch(/"span_id":"[0-9a-f]{16}"/i);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("does not fetch a credential or invoke an adapter when action.started cannot deliver", async () => {
    let secretsFetched = 0;
    let adapterCalled = 0;
    const failing = new BrokerPipeline({
      identities: new SessionIdentityResolver(postgres.sql),
      services: {
        resolveService: async () => ({
          adapter: trackedAdapter(() => {
            adapterCalled += 1;
          }),
          timeoutMs: 100,
        }),
        resolveCredentialRef: async () => ({
          backend: "env",
          backendPath: "UNUSED",
          role: "default",
        }),
      },
      policyBundles: new PolicyBundleLoader(postgres.sql),
      secrets: {
        fetch: async () => {
          secretsFetched += 1;
          throw new Error("should not fetch");
        },
        health: async () => true,
      },
      audit: new AuditOutboxWriter(postgres.sql, new FailingSink()),
    });
    await expect(
      failing.handle(hostPeer, {
        id: "audit-outage",
        op: "broker.call",
        body: {
          service: "postgres",
          method: "query",
          params: { sql: "SELECT 1" },
          idempotencyKey: "audit-outage",
          intent: "prove fail closed",
        },
      }),
    ).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(secretsFetched).toBe(0);
    expect(adapterCalled).toBe(0);
  });
});

function bootstrap(databaseUrl: string, script: string): void {
  const result = spawnSync(process.execPath, [`scripts/${script}`], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, CAISSON_DATABASE_URL: databaseUrl },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function trackedAdapter(onExecute: () => void): BrokerAdapter {
  return {
    name: "postgres",
    methods: {
      query: {
        params: { safeParse: () => ({ success: true, data: {} }) } as never,
        scopeRequired: "warehouse.readonly",
        sideEffecting: false,
        summarise: () => "test",
        execute: async () => {
          onExecute();
          return null;
        },
      },
    },
  };
}

class FailingSink implements AuditSink {
  async hasEvent(): Promise<boolean> {
    throw new Error("audit unavailable");
  }
  async insert(_event: StoredAuditEvent): Promise<void> {}
}

function pipeName(): string {
  return `\\\\.\\pipe\\caisson-pipeline-${randomUUID()}`;
}

async function exchange(endpointPath: string, request: unknown): Promise<unknown> {
  const socket = net.createConnection(endpointPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const response = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("close", () => resolve(Buffer.concat(chunks)));
    socket.once("error", reject);
    socket.write(encodeBrokerFrame(JSON.stringify(request)));
  });
  const declaredLength = response.readUInt32BE(0);
  if (response.length !== declaredLength + 4) throw new Error("invalid broker response frame");
  return JSON.parse(response.subarray(4).toString("utf8"));
}
