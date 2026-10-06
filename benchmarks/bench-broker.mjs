import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

import postgres from "postgres";
import { z } from "zod";
import { BrokerPipeline, DatabaseBrokerServiceResolver } from "../apps/broker/dist/index.js";
import {
  SessionActionGate,
  SessionIdentityResolver,
  SessionTokenService,
} from "../apps/control-plane/dist/index.js";
import { AuditOutboxWriter, ClickHouseAuditSink } from "../packages/audit/dist/index.js";
import { PolicyBundleLoader } from "../packages/policy/dist/index.js";
import { EnvSecretBackend } from "../packages/secrets/dist/index.js";
import { initializeTelemetry, shutdownTelemetry } from "../packages/telemetry/dist/index.js";

const execFileAsync = promisify(execFile);
const samples = Number.parseInt(process.env.CAISSON_BENCH_SAMPLES ?? "200", 10);
const warmupSamples = 20;
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
const phaseDurations = new Map();

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
const identities = new SessionIdentityResolver(sql);
const services = new DatabaseBrokerServiceResolver(sql, [adapter]);
const policyBundles = new PolicyBundleLoader(sql);
const secrets = new EnvSecretBackend({
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
});
const pipeline = new BrokerPipeline({
  actionGate: new SessionActionGate(),
  identities: {
    resolve: (...arguments_) =>
      measureAsync("identity.resolve", () => identities.resolve(...arguments_)),
  },
  services: {
    resolveService: async (...arguments_) => {
      const service = await measureAsync("service.resolve", () =>
        services.resolveService(...arguments_),
      );
      return {
        ...service,
        adapter: timedAdapter(service.adapter),
      };
    },
    resolveCredentialRef: (...arguments_) =>
      measureAsync("credential_ref.resolve", () => services.resolveCredentialRef(...arguments_)),
  },
  policyBundles: {
    load: async (...arguments_) => {
      const bundle = await measureAsync("policy.load", () => policyBundles.load(...arguments_));
      return {
        ...bundle,
        evaluator: {
          evaluate: (input) =>
            measureSync("policy.evaluate", () => bundle.evaluator.evaluate(input)),
        },
      };
    },
  },
  secrets: {
    fetch: (...arguments_) => measureAsync("credentials.fetch", () => secrets.fetch(...arguments_)),
  },
  audit: timedAuditWriter(audit),
});

await sink.ensureSchema();
initializeTelemetry();
const durations = [];
try {
  for (let index = 0; index < warmupSamples; index += 1) {
    const response = await pipeline.handle(peer, {
      ...request,
      id: `${request.id}-warmup-${index}`,
    });
    if (!response.ok) throw new Error(`broker benchmark warmup request ${index} was denied`);
  }
  phaseDurations.clear();
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
  warmupSamples,
  timingModel: "identity_policy_audit_credential_baseline_adapter",
  execution:
    "resolve peer identity, load and evaluate policy, synchronously persist action.started, resolve credentials, invoke a no-op adapter baseline, enqueue action.completed",
  excluded: "PostgreSQL network and query execution",
  nfr2TargetP99Ms: 50,
  p50Ms: percentile(durations, 0.5),
  p99Ms: percentile(durations, 0.99),
  samplesMs: durations.map((duration) => Math.round(duration * 1000) / 1000),
  phases: Object.fromEntries(
    [...phaseDurations.entries()].map(([phase, values]) => [
      phase,
      { p50Ms: percentile(values, 0.5), p99Ms: percentile(values, 0.99) },
    ]),
  ),
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
for (const [phase, values] of Object.entries(result.phases)) {
  process.stdout.write(`  ${phase}: p50 ${values.p50Ms}ms, p99 ${values.p99Ms}ms\n`);
}
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

function timedAdapter(adapter) {
  return {
    ...adapter,
    methods: Object.fromEntries(
      Object.entries(adapter.methods).map(([name, method]) => [
        name,
        {
          ...method,
          execute: (...arguments_) =>
            measureAsync("adapter.baseline_execute", () => method.execute(...arguments_)),
        },
      ]),
    ),
  };
}

function timedAuditWriter(writer) {
  return new Proxy(writer, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "persistBeforeExecution" && typeof value === "function") {
        return (...arguments_) =>
          measureAsync("audit.pre_execution", () => value.apply(target, arguments_));
      }
      if (property === "persistDurably" && typeof value === "function") {
        return (...arguments_) =>
          measureAsync("audit.terminal_enqueue", () => value.apply(target, arguments_));
      }
      return value;
    },
  });
}

async function measureAsync(phase, operation) {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    recordPhase(phase, performance.now() - startedAt);
  }
}

function measureSync(phase, operation) {
  const startedAt = performance.now();
  try {
    return operation();
  } finally {
    recordPhase(phase, performance.now() - startedAt);
  }
}

function recordPhase(phase, duration) {
  const values = phaseDurations.get(phase) ?? [];
  values.push(duration);
  phaseDurations.set(phase, values);
}
