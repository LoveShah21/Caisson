import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import postgres, { type Sql } from "postgres";
import { GenericContainer, Wait } from "testcontainers";

export interface PostgresFixture {
  readonly sql: Sql;
  readonly url: string;
  close(): Promise<void>;
}

export async function createPostgresFixture(): Promise<PostgresFixture> {
  const container = await new GenericContainer("postgres:17.11-alpine3.24")
    .withEnvironment({
      POSTGRES_DB: "caisson",
      POSTGRES_USER: "caisson",
      POSTGRES_PASSWORD: "caisson-postgres-test-only",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections"))
    .start();
  const url = `postgres://caisson:caisson-postgres-test-only@${container.getHost()}:${container.getMappedPort(5432)}/caisson`;
  const sql = postgres(url);

  await waitForDatabase(sql);
  await applyMigrations(sql);

  return {
    sql,
    url,
    async close() {
      await sql.end({ timeout: 5 });
      await container.stop();
    },
  };
}

async function waitForDatabase(sql: Sql): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (error: unknown) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function applyMigrations(sql: Sql): Promise<void> {
  for (const migration of [
    "0001_m0_foundations.sql",
    "0002_m2_session_identity.sql",
    "0003_m2_generalize_transport_bindings.sql",
    "0004_m2_audit_outbox.sql",
  ]) {
    const source = await readFile(resolve("packages/db/migrations", migration), "utf8");
    await sql.unsafe(source);
  }
}
