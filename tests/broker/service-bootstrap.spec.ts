import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

describe("service bootstrap and credential references", () => {
  let fixture: PostgresFixture;

  beforeAll(async () => {
    fixture = await createPostgresFixture();
  }, 30_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("upserts source-controlled service definitions and credential references", () => {
    const environment = { ...process.env, CAISSON_DATABASE_URL: fixture.url };
    const first = spawnSync(process.execPath, ["scripts/bootstrap-services.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
      stdio: "pipe",
    });
    const second = spawnSync(process.execPath, ["scripts/bootstrap-services.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
      stdio: "pipe",
    });

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.stdout).toContain("Bootstrapped 1 service definitions.");
  });

  it("keeps one service and one reference after a repeatable sync", async () => {
    const [services] = await fixture.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM services WHERE name = 'postgres'
    `;
    const [references] = await fixture.sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM credential_refs AS reference
      JOIN services AS service ON service.id = reference.service_id
      WHERE service.name = 'postgres' AND reference.role = 'default'
    `;
    expect(services?.count).toBe("1");
    expect(references?.count).toBe("1");
  });

  it("rejects recursively nested secret-shaped service metadata in PostgreSQL", async () => {
    await expect(
      fixture.sql`
        INSERT INTO services (id, name, adapter, config)
        VALUES (
          '018f0000-0000-7000-8000-000000000301',
          'unsafe-service',
          'http',
          ${fixture.sql.json({ nested: { api_key: "not-a-real-secret" } })}::jsonb
        )
      `,
    ).rejects.toBeDefined();
  });

  it("rejects secret-shaped backend paths while allowing reference names", async () => {
    const [service] = await fixture.sql<{ id: string }[]>`
      INSERT INTO services (id, name, adapter, config)
      VALUES ('018f0000-0000-7000-8000-000000000302', 'safe-service', 'http', '{}'::jsonb)
      RETURNING id
    `;
    if (service === undefined) throw new Error("service fixture did not insert");

    await expect(
      fixture.sql`
        INSERT INTO credential_refs (id, service_id, role, backend, backend_path)
        VALUES (
          '018f0000-0000-7000-8000-000000000303',
          ${service.id},
          'default',
          'env',
          'sk-abcdefghijklmnopqrstuv'
        )
      `,
    ).rejects.toBeDefined();
    await expect(
      fixture.sql`
        INSERT INTO credential_refs (id, service_id, role, backend, backend_path)
        VALUES (
          '018f0000-0000-7000-8000-000000000304',
          ${service.id},
          'default',
          'env',
          'CAISSON_HTTP_CREDENTIALS'
        )
      `,
    ).resolves.toBeDefined();
  });
});
