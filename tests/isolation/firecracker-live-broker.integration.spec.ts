import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BrokerPipeline,
  DatabaseBrokerServiceResolver,
  PostgresAdapter,
} from "../../apps/broker/src/index.js";
import {
  SessionIdentityResolver,
  SessionTokenService,
} from "../../apps/control-plane/src/index.js";
import {
  AuditOutboxWriter,
  ClickHouseAuditSink,
  containsSecretShape,
} from "../../packages/audit/src/index.js";
import { FirecrackerDriver, type PreparedSandbox } from "../../packages/isolation/src/index.js";
import { PolicyBundleLoader } from "../../packages/policy/src/index.js";
import { EnvSecretBackend } from "../../packages/secrets/src/index.js";
import {
  createInMemorySpanRecorder,
  initializeTelemetry,
  shutdownTelemetry,
  type InMemorySpanRecorder,
} from "../../packages/telemetry/src/index.js";
import { createClickHouseFixture, type ClickHouseFixture } from "../helpers/clickhouse.js";
import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";
import { RuntimeVsockTransportHost } from "../helpers/runtime-vsock-transport-host.js";

const runtimeRootfs = process.env.CAISSON_RUNTIME_DIAGNOSTIC_ROOTFS;
const kvmEnabled =
  process.env.CAISSON_RUNTIME_KVM_TESTS === "1" &&
  process.platform === "linux" &&
  runtimeRootfs !== undefined &&
  hasKvmAccess();
const sessionId = "018f0000-0000-7000-8000-000000000801";
const credentialCanary = "AKIA7M2C4N4RY0000000";
const bootArgs =
  "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro init=/init caisson.diagnostic_preflight=1";
const request = {
  id: "live-postgres-query",
  op: "broker.call" as const,
  body: {
    service: "postgres",
    method: "query",
    params: { sql: "SELECT value FROM live_broker_probe" },
    idempotencyKey: "live-postgres-query",
    intent: "read the live broker probe row",
  },
};

describe("INV-1: no secret in a Firecracker guest", () => {
  let postgres: PostgresFixture;
  let clickhouse: ClickHouseFixture;
  let adapter: PostgresAdapter;
  let audit: AuditOutboxWriter;
  let pipeline: BrokerPipeline;
  let spanRecorder: InMemorySpanRecorder;

  beforeAll(async () => {
    if (!kvmEnabled) return;
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
    await postgres.sql.unsafe(
      `CREATE ROLE caisson_live_reader LOGIN PASSWORD '${credentialCanary}'`,
    );
    await postgres.sql.unsafe("CREATE TABLE live_broker_probe (value text NOT NULL)");
    await postgres.sql.unsafe("INSERT INTO live_broker_probe (value) VALUES ('live-result')");
    await postgres.sql.unsafe("GRANT SELECT ON live_broker_probe TO caisson_live_reader");
    await postgres.sql`
      INSERT INTO sessions (
        id, status, agent_image, approval_mode, scopes, roles, policy_bundle_id,
        requested_by, hardware_isolated, driver, expires_at
      ) VALUES (
        ${sessionId}, 'ready', 'runtime-diagnostic', 'auto', ARRAY['warehouse.readonly'],
        ARRAY['analyst'], ${active.value.policyBundleId}, 'test operator', true, 'firecracker',
        '2026-12-31T00:00:00Z'
      )
    `;
    adapter = new PostgresAdapter({
      statementTimeoutMs: 1_000,
      rowLimit: 10,
      resultSizeBytes: 1_024,
    });
    audit = new AuditOutboxWriter(postgres.sql, sink);
    await shutdownTelemetry();
    spanRecorder = createInMemorySpanRecorder();
    initializeTelemetry({ spanProcessors: [spanRecorder.processor] });
    pipeline = new BrokerPipeline({
      identities: new SessionIdentityResolver(postgres.sql),
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
            readCredentials: { username: "caisson_live_reader", password: credentialCanary },
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
    await shutdownTelemetry();
    await Promise.all([postgres?.close(), clickhouse?.close()]);
  });

  it.skipIf(!kvmEnabled)(
    "keeps a distinct credential canary out of the guest before and after a real brokered Postgres query",
    async () => {
      const identities = new SessionIdentityResolver(postgres.sql);
      const host = new RuntimeVsockTransportHost({
        handleRequest: (peer, brokerRequest) => pipeline.handle(peer, brokerRequest),
      });
      const driver = new FirecrackerDriver({
        firecrackerPath: required("CAISSON_FIRECRACKER_BIN"),
        kernelImagePath: required("CAISSON_FIRECRACKER_KERNEL"),
        rootfsPath: runtimeRootfs!,
        runtimeDirectory: required("CAISSON_FIRECRACKER_RUNTIME_DIR"),
        snapshotDirectory: required("CAISSON_FIRECRACKER_SNAPSHOT_DIR"),
        hostId: "live-broker-host",
        bootArgs,
        oneShotBrokerRequest: request,
      });
      const prepared = await driver.prepare(
        { id: randomUUID(), image: "runtime-diagnostic" },
        host,
      );
      const tokens = new SessionTokenService(postgres.sql);
      const token = await tokens.mint({
        sessionId,
        scopes: ["warehouse.readonly"],
        expiresAt: new Date("2026-12-31T00:00:00Z"),
      });
      await identities.bind({ sessionId, tokenId: token.id, ...prepared.transport });
      const logs: string[] = [];
      const originalError = console.error;
      const originalLog = console.log;
      const originalWarn = console.warn;
      console.error = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      console.warn = (...values: unknown[]) => logs.push(values.map(String).join(" "));
      try {
        await driver.start(prepared.handle);
        const before = await driverDiagnostic(host, prepared, { operation: "scan_secret_shapes" });
        expect(before.value).toBe("[]");
        await driverDiagnostic(host, prepared, { operation: "continue_broker" });
        await waitFor(() => host.messages.length === 2);
        await audit.drainPending();
        expect(JSON.parse(host.messages[1]!)).toMatchObject({
          id: request.id,
          ok: true,
          body: { result: { rows: [{ value: "live-result" }] } },
        });
        expect(host.messages.some((message) => containsSecretShape(JSON.parse(message)))).toBe(
          false,
        );
        const after = await driverDiagnostic(host, prepared, { operation: "scan_secret_shapes" });
        expect(after.value).toBe("[]");
        const outbox = await postgres.sql<{ payload: unknown }[]>`
          SELECT payload FROM audit_outbox WHERE session_id = ${sessionId} ORDER BY seq
        `;
        const auditRows = await clickhouse.query(
          `SELECT * FROM actions WHERE session_id = '${sessionId}' FORMAT JSONEachRow`,
        );
        const observable = `${JSON.stringify(host.messages)}\n${JSON.stringify(outbox)}\n${auditRows}`;
        expect(observable).not.toContain(credentialCanary);
        expect(
          JSON.stringify(spanRecorder.finished().map((span) => span.attributes)),
        ).not.toContain(credentialCanary);
        expect(logs.join("\n")).not.toContain(credentialCanary);
      } finally {
        console.error = originalError;
        console.log = originalLog;
        console.warn = originalWarn;
        await driver.destroy(prepared.handle);
        await host.release(prepared.transport);
      }
    },
    120_000,
  );
});

function bootstrap(databaseUrl: string, script: string): void {
  const result = spawnSync(process.execPath, [`scripts/${script}`], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, CAISSON_DATABASE_URL: databaseUrl },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

async function driverDiagnostic(
  host: RuntimeVsockTransportHost,
  prepared: PreparedSandbox,
  request: { readonly operation: "scan_secret_shapes" } | { readonly operation: "continue_broker" },
) {
  const { callRuntimeDiagnostic } = await import("../../packages/isolation/src/index.js");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await callRuntimeDiagnostic(host.endpointFor(prepared.transport), request);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("runtime diagnostic did not become ready");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for live broker response");
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing ${name}`);
  return value;
}

function hasKvmAccess(): boolean {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
