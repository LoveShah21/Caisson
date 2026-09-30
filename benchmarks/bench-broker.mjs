import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

import postgres from "postgres";
import { z } from "zod";
import { BrokerPipeline, DatabaseBrokerServiceResolver } from "../apps/broker/dist/index.js";
import { SessionIdentityResolver, SessionTokenService } from "../apps/control-plane/dist/index.js";
import { AuditOutboxWriter, ClickHouseAuditSink } from "../packages/audit/dist/index.js";
import { PolicyBundleLoader } from "../packages/policy/dist/index.js";
import { EnvSecretBackend } from "../packages/secrets/dist/index.js";
import { initializeTelemetry, shutdownTelemetry } from "../packages/telemetry/dist/index.js";

const execFileAsync = promisify(execFile);
const samples = Number.parseInt(process.env.CAISSON_BENCH_SAMPLES ?? "200", 10);
const databaseUrl = required("CAISSON_DATABASE_URL");
const clickhouseUrl = required("CAISSON_CLICKHOUSE_URL");
const clickhouseUsername = required("CAISSON_CLICKHOUSE_USERNAME");
const clickhousePassword = required("CAISSON_CLICKHOUSE_PASSWORD");
const sessionId = randomUUID();
const peer = {
  hostId: "benchmark-host",
  transportKind: "vsock",
  peerIdentifier: `benchmark-${randomUUID()}`,
};
const request = {
  id: "broker-overhead-query",
  op: "broker.call",
  body: {
    service: "postgres",
    method: "query",
    params: { sql: "SELECT 1" },
    idempotencyKey: "broker-overhead-query",
    intent: "measure the broker pipeline without adapter execution",
  },
};

if (!Number.isInteger(samples) || samples < 200) {
  throw new Error("CAISSON_BENCH_SAMPLES must be an integer of at least 200");
}

await bootstrap("bootstrap-policy.mjs");
await bootstrap("bootstrap-services.mjs");

const sql = postgres(databaseUrl);
const sink = new ClickHouseAuditSink({
  url: clickhouseUrl,
  username: clickhouseUsername,
  password: clickhousePassword,
});
const audit = new AuditOutboxWriter(sql, sink);
const [active] = await sql`SELECT value FROM settings WHERE key = 'active_policy_bundle'`;
if (active === undefined || typeof active.value?.policyBundleId !== "string") {
  throw new Error("the active policy bundle was not bootstrapped");
}

await sql`
  INSERT INTO sessions (
    id, status, agent_image, approval_mode, scopes, roles, policy_bundle_id,
    requested_by, hardware_isolated, driver, expires_at
  ) VALUES (
    ${sessionId}, 'ready', 'benchmark', 'auto', ARRAY['warehouse.readonly'], ARRAY[]::text[],
    ${active.value.policyBundleId}, 'benchmark', false, 'container', '2026-12-31T00:00:00Z'
  )
`;

const tokens = new SessionTokenService(sql);
const token = await tokens.mint({
  sessionId,
  scopes: ["warehouse.readonly"],
  expiresAt: new Date("2026-12-31T00:00:00Z"),
});
await new SessionIdentityResolver(sql).bind({ sessionId, tokenId: token.id, ...peer });

const adapter = {
  name: "postgres",
  methods: {
    query: {
      params: z.object({ sql: z.string() }).strict(),
      scopeRequired: "warehouse.readonly",
      sideEffecting: false,
      summarise: () => "benchmark query",
      // This deliberate no-op is the baseline. The benchmark measures identity,
      // policy, audit and credential-broker overhead, not PostgreSQL execution.
      execute: async () => ({ rows: [{ value: 1 }], truncated: false }),
    },
  },
};
const pipeline = new BrokerPipeline({
  identities: new SessionIdentityResolver(sql),
  services: new DatabaseBrokerServiceResolver(sql, [adapter]),
  policyBundles: new PolicyBundleLoader(sql),
  secrets: new EnvSecretBackend({
    environment: {
      CAISSON_POSTGRES_CREDENTIALS: JSON.stringify({
        kind: "postgres",
        host: "benchmark.invalid",
        port: 5432,
        database: "benchmark",
        username: "benchmark",
        password: "benchmark-password-not-a-real-secret",
        readCredentials: {
          username: "benchmark_readonly",
          password: "benchmark-readonly-password-not-a-real-secret",
        },
        sslMode: "disable",
      }),
    },
    caissonEnvironment: "development",
  }),
  audit,
});

await sink.ensureSchema();
initializeTelemetry();
const durations = [];
try {
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    const response = await pipeline.handle(peer, { ...request, id: `${request.id}-${index}` });
    if (!response.ok) throw new Error(`broker benchmark request ${index} was denied`);
    durations.push(performance.now() - startedAt);
  }
  await audit.drainPending();
} finally {
  await shutdownTelemetry();
  await sql.end({ timeout: 5 });
}

const result = {
  benchmark: "broker-overhead",
  samples,
  timingModel: "identity_policy_audit_credential_baseline_adapter",
  execution:
    "resolve peer identity, load and evaluate policy, synchronously persist action.started, resolve credentials, invoke a no-op adapter baseline, enqueue action.completed",
  excluded: "PostgreSQL network and query execution",
  nfr2TargetP99Ms: 50,
  p50Ms: percentile(durations, 0.5),
  p99Ms: percentile(durations, 0.99),
  samplesMs: durations.map((duration) => Math.round(duration * 1000) / 1000),
  machine: {
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    node: process.version,
    docker: await dockerVersion(),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    cpuCount: os.cpus().length,
    memoryBytes: os.totalmem(),
  },
};
const outputDirectory = new URL("./results/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  new URL("broker-overhead.json", outputDirectory),
  `${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(
  `broker overhead: p50 ${result.p50Ms}ms, p99 ${result.p99Ms}ms, ${samples} samples\n`,
);
if (result.p99Ms >= result.nfr2TargetP99Ms) {
  process.exitCode = 1;
  process.stderr.write("NFR-2 missed: broker p99 must be below 50ms\n");
}

async function bootstrap(script) {
  const { stderr } = await execFileAsync(process.execPath, [`scripts/${script}`], {
    cwd: process.cwd(),
    env: { ...process.env, CAISSON_DATABASE_URL: databaseUrl },
  });
  if (stderr !== "") process.stderr.write(stderr);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.ceil(fraction * sorted.length) - 1] * 1000) / 1000;
}

async function dockerVersion() {
  try {
    const { stdout } = await execFileAsync("docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    return stdout.trim();
  } catch {
    return "unavailable";
  }
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing ${name}`);
  return value;
}
