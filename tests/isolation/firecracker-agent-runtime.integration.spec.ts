import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BrokerPipeline,
  DatabaseBrokerServiceResolver,
  FirecrackerBrokerTransportHost,
  LocalToolPipeline,
  PostgresAdapter,
} from "../../apps/broker/src/index.js";
import {
  SessionActionGate,
  SessionIdentityResolver,
  SessionSnapshotCrypto,
  SessionSnapshotService,
  type SessionSnapshotStore,
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
  type LocalSnapshot,
  type PreparedSandbox,
  type ResolvedSnapshot,
  type SnapshotRef,
} from "../../packages/isolation/src/index.js";
import { PolicyBundleLoader } from "../../packages/policy/src/index.js";
import { EnvSecretBackend, SecretString } from "../../packages/secrets/src/index.js";
import type { SecretBackend } from "../../packages/secrets/src/types.js";
import { type ClickHouseFixture, createClickHouseFixture } from "../helpers/clickhouse.js";
import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

const rootfsPath = process.env.CAISSON_AGENT_RUNTIME_DIAGNOSTIC_ROOTFS ?? "";
const kvmEnabled =
  process.env.CAISSON_RUNTIME_KVM_TESTS === "1" &&
  process.platform === "linux" &&
  rootfsPath !== "" &&
  hasKvmAccess();
const sessionId = "018f0000-0000-7000-8000-000000000901";
const baseSnapshotId = "018f0000-0000-7000-8000-000000000902";
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
  let actionGate: SessionActionGate;
  let tokenId: string;

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
    await postgres.sql`
      INSERT INTO snapshots (
        id, kind, bucket, manifest_key, manifest_sha256, manifest_size_bytes,
        manifest_key_id, built_at
      ) VALUES (
        ${baseSnapshotId}, 'base', 'test', 'base/manifest.json', ${"a".repeat(64)}, 1,
        'test-manifest-key', now()
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
    actionGate = new SessionActionGate();
    broker = new BrokerPipeline({
      identities,
      services,
      policyBundles,
      secrets,
      audit,
      actionGate,
    });
    localTools = new LocalToolPipeline({
      identities,
      policyBundles,
      audit,
      actionGate,
      // Deliberately small so the diagnostic completion test proves the host,
      // not the guest, derives a bounded response and audit metadata.
      resultMaxBytes: 128,
      previewMaxBytes: 64,
    });
    tokenId = (
      await new SessionTokenService(postgres.sql).mint({
        sessionId,
        scopes: [
          "workspace.read",
          "workspace.write",
          "process.exec",
          "user.ask",
          "warehouse.readonly",
        ],
        expiresAt: new Date("2026-12-31T00:00:00Z"),
      })
    ).id;
  }, 90_000);

  afterAll(async () => {
    await adapter?.close();
    await Promise.all([postgres?.close(), clickhouse?.close()]);
  });

  it.skipIf(!kvmEnabled)(
    "authorizes, audits, and fails closed for all seven tools through real host vsock listeners",
    async () => {
      const host = new FirecrackerBrokerTransportHost({
        pipeline: broker,
        runtimeDirectory: required("CAISSON_FIRECRACKER_RUNTIME_DIR"),
        localTools: {
          frameReadTimeoutMs: 5_000,
          completionTimeoutMs: 100,
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
      await identities.bind({
        sessionId,
        tokenId,
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
        const forbiddenProcess = await invoke(host, prepared, {
          id: "agent-exec-shell",
          op: "proc.exec",
          body: { argv: ["sh", "-c", "touch /workspace/should-not-exist"] },
        });
        // This denial is emitted by LocalToolPipeline before the runtime can
        // execute argv. It proves the host does not trust a guest report.
        expect(forbiddenProcess).toMatchObject({
          ok: false,
          error: { code: "BINARY_NOT_ALLOWED" },
        });
        for (const [id, argv] of [
          ["agent-exec-git-push", ["git", "push"]],
          ["agent-exec-workspace", ["/workspace/uploaded", "--version"]],
          ["agent-exec-path", ["PATH=/workspace", "cat", "/workspace/note.txt"]],
          ["agent-exec-preload", ["LD_PRELOAD=/workspace/libevil.so", "cat"]],
        ] as const) {
          const denied = await invoke(host, prepared, {
            id,
            op: "proc.exec",
            body: { argv },
          });
          expect(denied).toMatchObject({ ok: false, error: { code: "BINARY_NOT_ALLOWED" } });
        }
        // The semicolon is an argv element, not a command separator. `cat`
        // reports missing literal files; it must never create the marker.
        const metacharacters = await invoke(host, prepared, {
          id: "agent-exec-metacharacters",
          op: "proc.exec",
          body: { argv: ["cat", ";touch", "/workspace/inv8-marker"] },
        });
        expect(metacharacters).toMatchObject({
          ok: true,
          body: { result: { truncated: true } },
        });
        const marker = await invoke(host, prepared, {
          id: "agent-read-metacharacter-marker",
          op: "fs.read",
          body: { path: "/workspace/inv8-marker" },
        });
        expect(marker).toMatchObject({ ok: false });
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
        await expect(
          waitForDiagnostic(host.endpointFor(prepared.transport), {
            operation: "agent_fault",
            value: "abandon",
          }),
        ).resolves.toMatchObject({ value: "authorized" });
        const invalidCompletion = await waitForDiagnostic(host.endpointFor(prepared.transport), {
          operation: "agent_fault",
          value: "invalid_completion",
        });
        expect(JSON.parse(invalidCompletion.value ?? "")).toMatchObject({
          ok: false,
          error: { code: "PARAMS_INVALID" },
        });
        const oversized = await waitForDiagnostic(host.endpointFor(prepared.transport), {
          operation: "agent_fault",
          value: "oversized",
        });
        const oversizedResponse = JSON.parse(oversized.value ?? "") as {
          body?: {
            result?: { truncated?: boolean; preview?: string };
            meta?: { truncated?: boolean };
          };
        };
        expect(oversizedResponse).toMatchObject({
          ok: true,
          body: { result: { truncated: true }, meta: { truncated: true } },
        });
        expect(oversizedResponse.body?.result?.preview).toHaveLength(128);
        await audit.drainPending();
        const rows = (
          await clickhouse.query(
            `SELECT method, event_type, result_bytes, result_hash, params_preview FROM actions WHERE session_id = '${sessionId}' ORDER BY seq FORMAT JSONEachRow`,
          )
        )
          .trim()
          .split("\n")
          .filter((row) => row !== "")
          .map(
            (row) =>
              JSON.parse(row) as {
                method: string;
                event_type: string;
                result_bytes: number;
                result_hash: string;
                params_preview: string;
              },
          );
        for (const [method, terminal] of [
          ["fs.write", "action.completed"],
          ["fs.read", "action.completed"],
          ["fs.edit", "action.completed"],
          ["fs.search", "action.completed"],
          ["proc.exec", "action.completed"],
          ["user.ask", "action.failed"],
          ["query", "action.completed"],
        ] as const) {
          expect(
            rows.some((row) => row.method === method && row.event_type === "action.started"),
          ).toBe(true);
          expect(rows.some((row) => row.method === method && row.event_type === terminal)).toBe(
            true,
          );
        }
        expect(
          rows.some((row) => row.method === "proc.exec" && row.event_type === "action.denied"),
        ).toBe(true);
        expect(
          rows.some((row) => row.method === "fs.read" && row.event_type === "action.abandoned"),
        ).toBe(true);
        expect(
          rows.some(
            (row) => row.method === "fs.read" && row.event_type === "action.invalid_completion",
          ),
        ).toBe(true);
        const invalidCompletionAudit = rows.find(
          (row) => row.method === "fs.read" && row.event_type === "action.invalid_completion",
        );
        expect(invalidCompletionAudit).toMatchObject({
          params_preview: "",
          result_bytes: 0,
          result_hash: "0".repeat(64),
        });
        const truncatedAudit = rows.find(
          (row) =>
            row.method === "fs.read" &&
            row.event_type === "action.completed" &&
            row.result_bytes > 128,
        );
        expect(truncatedAudit).toMatchObject({
          result_bytes: Buffer.byteLength(JSON.stringify({ value: "x".repeat(4096) }), "utf8"),
          result_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(Buffer.byteLength(truncatedAudit?.params_preview ?? "", "utf8")).toBeLessThanOrEqual(
          64,
        );
        const serializedRows = JSON.stringify(rows);
        expect(serializedRows).not.toContain(credentialCanary);
      } finally {
        await driver.destroy(prepared.handle);
        await releaseTransportBinding(identities, host, prepared);
      }
    },
    180_000,
  );

  it.skipIf(!kvmEnabled)(
    "captures a concurrent action at its durable suspension point and resumes only after entropy",
    async () => {
      const host = new FirecrackerBrokerTransportHost({
        pipeline: broker,
        runtimeDirectory: required("CAISSON_FIRECRACKER_RUNTIME_DIR"),
        localTools: {
          frameReadTimeoutMs: 5_000,
          completionTimeoutMs: 5_000,
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
      const source = await driver.prepare({ id: randomUUID(), image: "agent-runtime" }, host);
      await identities.bind({
        sessionId,
        tokenId,
        hostId: source.transport.hostId,
        transportKind: source.transport.kind,
        peerIdentifier: source.transport.peerIdentifier,
      });
      const store = new BlockingLocalSnapshotStore(sessionId, baseSnapshotId);
      const snapshotService = new SessionSnapshotService({
        sql: postgres.sql,
        driver,
        transportHost: host,
        crypto: new SessionSnapshotCrypto(new KvmSnapshotKeyBackend(), {
          backend: "env",
          backendPath: "KVM_SESSION_SNAPSHOT_KEK",
          role: "snapshot-kek",
        }),
        store,
        baseStore: {
          resolve: async (ref) => ({
            ref,
            statePath: "unused-base-state",
            memoryPath: "unused-base-memory",
            rootfsPath,
            kernelPath: required("CAISSON_FIRECRACKER_KERNEL"),
          }),
          release: async () => undefined,
        },
        bindRestoredTransport: async (boundSessionId, prepared) =>
          identities.bind({
            sessionId: boundSessionId,
            tokenId,
            hostId: prepared.transport.hostId,
            transportKind: prepared.transport.kind,
            peerIdentifier: prepared.transport.peerIdentifier,
          }),
        actionGate,
        captureDrainTimeoutMs: 5_000,
        retention: { count: 10, durationMs: 60_000 },
      });
      await snapshotService.provisionSessionKey(postgres.sql, sessionId);
      let restored: PreparedSandbox | undefined;
      try {
        await driver.start(source.handle);
        const runningAction = invoke(host, source, {
          id: "snapshot-race-action",
          op: "proc.exec",
          body: {
            argv: [
              "python3",
              "-c",
              "import time; time.sleep(0.25); open('/workspace/captured-marker','w').write('captured')",
            ],
          },
        });
        await waitForAudit(postgres, sessionId, "proc.exec", "action.started");
        const capture = snapshotService.capture(sessionId, source, baseSnapshotId);
        const actionResponse = (await runningAction) as {
          body?: { meta?: { actionId?: string } };
        };
        const actionId = actionResponse.body?.meta?.actionId;
        expect(actionId).toMatch(/^[0-9a-f-]{36}$/iu);
        await store.waitUntilStoreStarted();

        const deniedDuringCommit = await invoke(host, source, {
          id: "snapshot-gate-write",
          op: "fs.write",
          body: { path: "/workspace/must-not-exist", content: "blocked" },
        });
        expect(deniedDuringCommit).toMatchObject({
          ok: false,
          error: { code: "SESSION_SUSPENDED" },
        });
        store.releaseStore();
        const ref = await capture;
        const [point] = await postgres.sql<
          { resume_audit_seq: number; resume_action_id: string }[]
        >`
          SELECT resume_audit_seq, resume_action_id FROM snapshots WHERE id = ${ref.id}
        `;
        expect(point?.resume_action_id).toBe(actionId);

        await driver.destroy(source.handle);
        await releaseTransportBinding(identities, host, source);
        restored = await snapshotService.restore(ref, sessionId, {
          id: randomUUID(),
          image: "agent-runtime",
        });
        const capturedMarker = await invoke(host, restored, {
          id: "snapshot-read-captured-marker",
          op: "fs.read",
          body: { path: "/workspace/captured-marker" },
        });
        expect(capturedMarker).toMatchObject({
          ok: true,
          body: { result: { content: "captured" } },
        });
        const deniedMarker = await invoke(host, restored, {
          id: "snapshot-read-denied-marker",
          op: "fs.read",
          body: { path: "/workspace/must-not-exist" },
        });
        expect(deniedMarker).toMatchObject({ ok: false });
        const restoredLog = await readFile(
          join(required("CAISSON_FIRECRACKER_RUNTIME_DIR"), restored.handle.id, "firecracker.log"),
          "utf8",
        );
        const entropyIndex = restoredLog.lastIndexOf("caisson runtime: entropy refreshed");
        const resumeIndex = restoredLog.lastIndexOf("caisson runtime: resume accepted");
        expect(entropyIndex).toBeGreaterThanOrEqual(0);
        expect(resumeIndex).toBeGreaterThan(entropyIndex);
      } finally {
        if (restored !== undefined) {
          await driver.destroy(restored.handle);
          await releaseTransportBinding(identities, host, restored);
        } else {
          await driver.destroy(source.handle).catch(() => undefined);
          await releaseTransportBinding(identities, host, source).catch(() => undefined);
        }
      }
    },
    180_000,
  );
});

async function releaseTransportBinding(
  identityResolver: SessionIdentityResolver,
  host: FirecrackerBrokerTransportHost,
  prepared: PreparedSandbox,
): Promise<void> {
  try {
    await identityResolver.release({
      hostId: prepared.transport.hostId,
      transportKind: prepared.transport.kind,
      peerIdentifier: prepared.transport.peerIdentifier,
    });
  } finally {
    await host.release(prepared.transport);
  }
}

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
    | { readonly operation: "agent_socket_stat" }
    | {
        readonly operation: "agent_fault";
        readonly value: "abandon" | "invalid_completion" | "oversized";
      },
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

async function waitForAudit(
  postgres: PostgresFixture,
  targetSessionId: string,
  method: string,
  eventType: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await postgres.sql<{ found: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM audit_outbox
        WHERE session_id = ${targetSessionId}
          AND payload->>'method' = ${method}
          AND payload->>'eventType' = ${eventType}
      ) AS found
    `;
    if (row?.found === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`audit event did not appear: ${method} ${eventType}`);
}

class BlockingLocalSnapshotStore implements SessionSnapshotStore {
  readonly #sessionId: string;
  readonly #baseSnapshotId: string;
  #local: LocalSnapshot | undefined;
  #startedResolve!: () => void;
  readonly #started = new Promise<void>((resolve) => (this.#startedResolve = resolve));
  #releaseResolve!: () => void;
  readonly #release = new Promise<void>((resolve) => (this.#releaseResolve = resolve));

  constructor(sessionId: string, baseSnapshotId: string) {
    this.#sessionId = sessionId;
    this.#baseSnapshotId = baseSnapshotId;
  }

  async store(local: LocalSnapshot): Promise<SnapshotRef> {
    this.#local = local;
    this.#startedResolve();
    await this.#release;
    return {
      id: local.id,
      kind: "session",
      manifest: {
        bucket: "kvm-local",
        key: `${local.id}/manifest.json`,
        sha256: "d".repeat(64),
        sizeBytes: 1,
      },
      manifestKeyId: "kvm-local",
      createdAt: local.createdAt,
      sessionId: this.#sessionId,
      baseSnapshotId: this.#baseSnapshotId,
    };
  }

  async resolve(ref: SnapshotRef, input: { base: ResolvedSnapshot }): Promise<ResolvedSnapshot> {
    const local = this.#local;
    if (local === undefined || local.id !== ref.id)
      throw new Error("local snapshot is unavailable");
    return {
      ref,
      statePath: local.statePath,
      memoryPath: local.memoryPath,
      rootfsPath: input.base.rootfsPath,
      kernelPath: input.base.kernelPath,
    };
  }

  async deleteObjects(): Promise<void> {}

  waitUntilStoreStarted(): Promise<void> {
    return this.#started;
  }

  releaseStore(): void {
    this.#releaseResolve();
  }
}

class KvmSnapshotKeyBackend implements SecretBackend {
  readonly #key = randomBytes(32).toString("base64");

  async fetch() {
    return {
      kind: "snapshot_kek" as const,
      keyId: "kvm-test-root-kek",
      key: new SecretString(this.#key),
    };
  }

  async health(): Promise<boolean> {
    return true;
  }
}
