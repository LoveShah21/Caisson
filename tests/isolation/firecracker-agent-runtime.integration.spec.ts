import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BrokerPipeline,
  DatabaseBrokerServiceResolver,
  FirecrackerBrokerTransportHost,
  LocalToolPipeline,
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
import {
  callRuntimeDiagnostic,
  FirecrackerDriver,
  type PreparedSandbox,
} from "../../packages/isolation/src/index.js";
import { PolicyBundleLoader } from "../../packages/policy/src/index.js";
import { EnvSecretBackend } from "../../packages/secrets/src/index.js";
import { type ClickHouseFixture, createClickHouseFixture } from "../helpers/clickhouse.js";
import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

const rootfsPath = process.env.CAISSON_AGENT_RUNTIME_DIAGNOSTIC_ROOTFS ?? "";
const kvmEnabled =
  process.env.CAISSON_RUNTIME_KVM_TESTS === "1" &&
  process.platform === "linux" &&
  rootfsPath !== "" &&
  hasKvmAccess();
const sessionId = "018f0000-0000-7000-8000-000000000901";
const credentialCanary = "AKIAAGENTRUNTIME0000";
const bootArgs = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro init=/init";
const readinessRequest = {
  id: "agent-runtime-readiness",
  op: "broker.call" as const,
  body: {
    service: "postgres",
    method: "query",
    params: { sql: "SELECT 1" },
    idempotencyKey: "agent-runtime-readiness",
    intent: "enable the host entropy readiness gate",
  },
};

describe("Firecracker M-3 agent runtime", () => {
  let postgres: PostgresFixture;
  let clickhouse: ClickHouseFixture;
  let adapter: PostgresAdapter;
  let audit: AuditOutboxWriter;
  let identities: SessionIdentityResolver;
  let broker: BrokerPipeline;
  let localTools: LocalToolPipeline;

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
      `CREATE ROLE caisson_agent_reader LOGIN PASSWORD '${credentialCanary}'`,
    );
    await postgres.sql.unsafe("CREATE TABLE agent_runtime_probe (value text NOT NULL)");
    await postgres.sql.unsafe("INSERT INTO agent_runtime_probe (value) VALUES ('brokered-value')");
    await postgres.sql.unsafe("GRANT SELECT ON agent_runtime_probe TO caisson_agent_reader");
    await postgres.sql`
      INSERT INTO sessions (
        id, status, agent_image, approval_mode, scopes, roles, policy_bundle_id,
        requested_by, hardware_isolated, driver, expires_at
      ) VALUES (
        ${sessionId}, 'ready', 'agent-runtime-diagnostic', 'auto',
        ARRAY['workspace.read', 'workspace.write', 'process.exec', 'user.ask', 'warehouse.readonly'],
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
    identities = new SessionIdentityResolver(postgres.sql);
    const services = new DatabaseBrokerServiceResolver(postgres.sql, [adapter]);
    const secrets = new EnvSecretBackend({
      environment: {
        CAISSON_POSTGRES_CREDENTIALS: JSON.stringify({
          kind: "postgres",
          host: new URL(postgres.url).hostname,
          port: Number(new URL(postgres.url).port),
          database: "caisson",
          username: "caisson",
          password: "caisson-postgres-test-only",
          readCredentials: { username: "caisson_agent_reader", password: credentialCanary },
          sslMode: "disable",
        }),
      },
      caissonEnvironment: "development",
    });
    const policyBundles = new PolicyBundleLoader(postgres.sql);
    broker = new BrokerPipeline({ identities, services, policyBundles, secrets, audit });
    localTools = new LocalToolPipeline({
      identities,
      policyBundles,
      audit,
      resultMaxBytes: 1_024 * 1_024,
      previewMaxBytes: 4_096,
    });
  }, 90_000);

  afterAll(async () => {
    await adapter?.close();
    await Promise.all([postgres?.close(), clickhouse?.close()]);
  });

  it.skipIf(!kvmEnabled)(
    "authorizes and audits all seven tools through the agent socket and real host vsock listeners",
    async () => {
      const host = new FirecrackerBrokerTransportHost({
        pipeline: broker,
        runtimeDirectory: required("CAISSON_FIRECRACKER_RUNTIME_DIR"),
        localTools: {
          frameReadTimeoutMs: 5_000,
          completionTimeoutMs: 30_000,
          pipeline: localTools,
        },
      });
      const driver = new FirecrackerDriver({
        firecrackerPath: required("CAISSON_FIRECRACKER_BIN"),
        kernelImagePath: required("CAISSON_FIRECRACKER_KERNEL"),
        rootfsPath,
        runtimeDirectory: required("CAISSON_FIRECRACKER_RUNTIME_DIR"),
        snapshotDirectory: required("CAISSON_FIRECRACKER_SNAPSHOT_DIR"),
        bootArgs,
        oneShotBrokerRequest: readinessRequest,
      });
      const prepared = await driver.prepare({ id: randomUUID(), image: "agent-runtime" }, host);
      const token = await new SessionTokenService(postgres.sql).mint({
        sessionId,
        scopes: [
          "workspace.read",
          "workspace.write",
          "process.exec",
          "user.ask",
          "warehouse.readonly",
        ],
        expiresAt: new Date("2026-12-31T00:00:00Z"),
      });
      await identities.bind({
        sessionId,
        tokenId: token.id,
        hostId: prepared.transport.hostId,
        transportKind: prepared.transport.kind,
        peerIdentifier: prepared.transport.peerIdentifier,
      });
      try {
        await driver.start(prepared.handle);
        await expect(
          waitForDiagnostic(host.endpointFor(prepared.transport), {
            operation: "agent_socket_stat",
          }),
        ).resolves.toMatchObject({ value: "0600:65532:65532" });
        const write = await invoke(host, prepared, {
          id: "agent-write",
          op: "fs.write",
          body: { path: "/workspace/note.txt", content: "hello agent runtime" },
        });
        expect(write).toMatchObject({ ok: true, body: { result: { bytes: 19 } } });
        const read = await invoke(host, prepared, {
          id: "agent-read",
          op: "fs.read",
          body: { path: "/workspace/note.txt" },
        });
        expect(read).toMatchObject({
          ok: true,
          body: { result: { content: "hello agent runtime" } },
        });
        const edit = await invoke(host, prepared, {
          id: "agent-edit",
          op: "fs.edit",
          body: { path: "/workspace/note.txt", oldString: "agent", newString: "guest" },
        });
        expect(edit).toMatchObject({ ok: true });
        const search = await invoke(host, prepared, {
          id: "agent-search",
          op: "fs.search",
          body: { pattern: "guest", path: "/workspace/note.txt" },
        });
        expect(search).toMatchObject({
          ok: true,
          body: { result: { matches: expect.stringContaining("guest") } },
        });
        const processResult = await invoke(host, prepared, {
          id: "agent-exec",
          op: "proc.exec",
          body: { argv: ["cat", "/workspace/note.txt"] },
        });
        expect(processResult).toMatchObject({
          ok: true,
          body: { result: { stdout: "hello guest runtime" } },
        });
        const ask = await invoke(host, prepared, {
          id: "agent-ask",
          op: "user.ask",
          body: { question: "May I continue?", options: ["yes", "no"] },
        });
        expect(ask).toMatchObject({ ok: false, error: { code: "APPROVAL_UNAVAILABLE" } });
        const brokerResult = await invoke(host, prepared, {
          id: "agent-broker",
          op: "broker.call",
          body: {
            service: "postgres",
            method: "query",
            params: { sql: "SELECT value FROM agent_runtime_probe" },
            idempotencyKey: "agent-broker",
            intent: "read the brokered runtime probe",
          },
        });
        expect(brokerResult).toMatchObject({
          ok: true,
          body: { result: { rows: [{ value: "brokered-value" }] } },
        });
        expect(
          containsSecretShape([write, read, edit, search, processResult, ask, brokerResult]),
        ).toBe(false);
        await audit.drainPending();
        const rows = await clickhouse.query(
          `SELECT method, event_type FROM actions WHERE session_id = '${sessionId}' ORDER BY seq FORMAT JSONEachRow`,
        );
        for (const method of [
          "fs.write",
          "fs.read",
          "fs.edit",
          "fs.search",
          "proc.exec",
          "user.ask",
          "query",
        ]) {
          expect(rows).toContain(`"method":"${method}"`);
        }
        expect(rows).toContain('"event_type":"action.started"');
        expect(rows).toContain('"event_type":"action.completed"');
        expect(rows).toContain('"event_type":"action.failed"');
        expect(rows).not.toContain(credentialCanary);
      } finally {
        await driver.destroy(prepared.handle);
        await host.release(prepared.transport);
      }
    },
    180_000,
  );
});

async function invoke(
  host: FirecrackerBrokerTransportHost,
  prepared: PreparedSandbox,
  request: unknown,
): Promise<unknown> {
  const response = await waitForDiagnostic(host.endpointFor(prepared.transport), {
    operation: "agent_tool",
    value: JSON.stringify(request),
  });
  if (response.value === undefined) throw new Error("agent runtime diagnostic lacks a response");
  return JSON.parse(response.value);
}

async function waitForDiagnostic(
  endpointPath: string,
  request:
    | { readonly operation: "agent_tool"; readonly value: string }
    | { readonly operation: "agent_socket_stat" },
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await callRuntimeDiagnostic(endpointPath, request);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

function bootstrap(databaseUrl: string, script: string): void {
  const result = spawnSync(process.execPath, [`scripts/${script}`], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, CAISSON_DATABASE_URL: databaseUrl },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
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
