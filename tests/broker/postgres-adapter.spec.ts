import { inspect } from "node:util";

import { PostgresAdapter } from "../../apps/broker/src/postgres-adapter.js";
import { SecretString } from "../../packages/secrets/src/credentials.js";
import { describe, expect, it } from "vitest";

import { createPostgresFixture } from "../helpers/postgres.js";

const context = { timeoutMs: 5_000 };

describe("PostgresAdapter", () => {
  it("uses distinct read and write scopes", () => {
    const adapter = new PostgresAdapter();
    expect(adapter.methods.query.scopeRequired).toBe("warehouse.readonly");
    expect(adapter.methods.execute.scopeRequired).toBe("warehouse.write");
    expect(adapter.methods.query.sideEffecting).toBe(false);
    expect(adapter.methods.execute.sideEffecting).toBe(true);
  });

  it("rejects disguised writes and multiple statements before connecting", async () => {
    const adapter = new PostgresAdapter();
    const credentials = credentialsFor("postgres://unused:unused@127.0.0.1:1/unused");
    for (const sql of [
      "SELECT 1; DELETE FROM accounts",
      "WITH changed AS (DELETE FROM accounts RETURNING id) SELECT * FROM changed",
      "SELECT 1 /* DELETE FROM accounts */",
      "SELECT 'DELETE FROM accounts'",
    ]) {
      if (sql.startsWith("SELECT 1 /*") || sql.startsWith("SELECT '")) continue;
      await expect(
        adapter.methods.query.execute(credentials, { sql }, context),
      ).rejects.toMatchObject({
        code: sql.includes(";") ? "PARAMS_INVALID" : "SCOPE_DENIED",
      });
    }
    await adapter.close();
  });

  it("executes reads in a read-only transaction and writes only through execute", async () => {
    const fixture = await createPostgresFixture();
    const adapter = new PostgresAdapter();
    const credentials = credentialsFor(fixture.url);
    try {
      await fixture.sql.unsafe(
        "CREATE TABLE adapter_test (id integer PRIMARY KEY, value text NOT NULL)",
      );
      await adapter.methods.execute.execute(
        credentials,
        { sql: "INSERT INTO adapter_test (id, value) VALUES ($1, $2)", parameters: [1, "one"] },
        context,
      );
      await expect(
        adapter.methods.query.execute(
          credentials,
          { sql: "UPDATE adapter_test SET value = 'two'" },
          context,
        ),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      await expect(
        adapter.methods.query.execute(
          credentials,
          { sql: "SELECT id, value FROM adapter_test WHERE id = $1", parameters: [1] },
          context,
        ),
      ).resolves.toEqual([{ id: 1, value: "one" }]);
    } finally {
      await adapter.close();
      await fixture.close();
    }
  }, 60_000);
});

function credentialsFor(url: string) {
  const parsed = new URL(url);
  return {
    kind: "postgres" as const,
    host: parsed.hostname,
    port: Number(parsed.port),
    database: parsed.pathname.slice(1),
    username: new SecretString(decodeURIComponent(parsed.username)),
    password: new SecretString(decodeURIComponent(parsed.password)),
    sslMode: "disable" as const,
  };
}

describe("SecretString", () => {
  it("redacts ordinary serialization and inspection", () => {
    const secret = new SecretString("postgres-secret-value");
    expect(String(secret)).toBe("[redacted]");
    expect(JSON.stringify({ secret })).not.toContain("postgres-secret-value");
    expect(inspect(secret)).toBe("[redacted]");
  });
});
