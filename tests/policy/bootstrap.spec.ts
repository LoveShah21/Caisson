import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPolicyTests } from "../../scripts/policy-opa.mjs";
import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

describe("policy bootstrap", () => {
  let postgres: PostgresFixture;

  beforeAll(async () => {
    postgres = await createPostgresFixture();
  }, 30_000);

  afterAll(async () => {
    await postgres?.close();
  });

  it("compiles the source-controlled bundle and is idempotent", () => {
    const environment = { ...process.env, CAISSON_DATABASE_URL: postgres.url };
    const first = spawnSync(process.execPath, ["scripts/bootstrap-policy.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
      stdio: "pipe",
    });
    const second = spawnSync(process.execPath, ["scripts/bootstrap-policy.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
      stdio: "pipe",
    });

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.stdout).toMatch(/Bootstrapped policy bundle \([1-9][0-9]* bytes\)/);
  }, 60_000);

  it("creates one source-hash bundle and one active pointer after repeated bootstrap", async () => {
    const [bundles] = await postgres.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM policy_bundles
    `;
    const [active] = await postgres.sql<{ value: { policyBundleId: string } }[]>`
      SELECT value FROM settings WHERE key = 'active_policy_bundle'
    `;

    expect(bundles?.count).toBe("1");
    expect(active?.value.policyBundleId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rejects a policy source whose own Rego test fails before it can be bootstrapped", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caisson-bad-policy-"));
    try {
      await writeFile(
        join(directory, "default.rego"),
        'package caisson.bootstrap\nimport rego.v1\ndefault decision := {"decision": "allow"}\n',
      );
      await writeFile(
        join(directory, "default_test.rego"),
        'package caisson.bootstrap\nimport rego.v1\ntest_default_denies if { decision.decision == "deny" }\n',
      );
      await expect(runPolicyTests(directory)).rejects.toThrow("OPA policy tests failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
