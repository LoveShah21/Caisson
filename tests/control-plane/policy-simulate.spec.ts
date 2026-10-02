import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneServer } from "../../apps/control-plane/src/server.js";
import { SystemAuditWriter } from "../../packages/audit/src/index.js";
import { PolicyBundleLoader } from "../../packages/policy/src/index.js";

import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

describe("POST /v1/policy/simulate", () => {
  let postgres: PostgresFixture;

  beforeAll(async () => {
    postgres = await createPostgresFixture();
    const bootstrapped = spawnSync(process.execPath, ["scripts/bootstrap-policy.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CAISSON_DATABASE_URL: postgres.url },
    });
    if (bootstrapped.status !== 0) throw new Error(bootstrapped.stderr || bootstrapped.stdout);
  }, 60_000);

  afterAll(async () => postgres?.close());

  it("evaluates the active bundle and writes a non-session system audit event", async () => {
    const app = createApp(postgres);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/policy/simulate",
        payload: {
          session: { scopes: ["warehouse.readonly"] },
          action: { scopeRequired: "warehouse.readonly" },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        decision: "allow",
        matchedRules: ["scope_required"],
      });
      const [audit] = await postgres.sql<
        {
          input_hash: string;
          outcome: string;
          trace_id: string;
          span_id: string;
          caller_connection: string | null;
        }[]
      >`
        SELECT input_hash, outcome, trace_id, span_id, caller_connection
        FROM system_audit_events
        WHERE event_type = 'policy.simulate'
      `;
      expect(audit).toMatchObject({ outcome: "allow", caller_connection: "127.0.0.1" });
      expect(audit?.input_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(audit?.trace_id).toMatch(/^[0-9a-f]{32}$/i);
      expect(audit?.span_id).toMatch(/^[0-9a-f]{16}$/i);
    } finally {
      await app.close();
    }
  });

  it("rejects secret-shaped input without writing input-derived audit material", async () => {
    const app = createApp(postgres);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/policy/simulate",
        payload: { action: { token: "not-a-real-secret" } },
      });
      expect(response.statusCode).toBe(400);
      const [count] = await postgres.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM system_audit_events
      `;
      expect(count?.count).toBe("1");
    } finally {
      await app.close();
    }
  });
});

function createApp(postgres: PostgresFixture) {
  return createControlPlaneServer({
    lifecycle: { reconcile: async () => undefined } as never,
    policyBundles: new PolicyBundleLoader(postgres.sql),
    systemAudit: new SystemAuditWriter(postgres.sql),
    reconcileIntervalMs: 60_000,
  });
}
