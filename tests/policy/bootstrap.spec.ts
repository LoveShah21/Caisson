import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    });
    const second = spawnSync(process.execPath, ["scripts/bootstrap-policy.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
    });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
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
});
