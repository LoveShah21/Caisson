import { inspect } from "node:util";

import { PostgresAdapter } from "../../apps/broker/src/postgres-adapter.js";
import { SecretString } from "../../packages/secrets/src/credentials.js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { createPostgresFixture } from "../helpers/postgres.js";

const context = { timeoutMs: 5_000 };
const config = { statementTimeoutMs: 1_000, rowLimit: 2, resultSizeBytes: 1_024 };

describe("PostgresAdapter", () => {
  it("uses distinct read and write scopes", () => {
    const adapter = new PostgresAdapter(config);
    expect(adapter.methods.query.scopeRequired).toBe("warehouse.readonly");
    expect(adapter.methods.execute.scopeRequired).toBe("warehouse.write");
    expect(adapter.methods.query.sideEffecting).toBe(false);
    expect(adapter.methods.execute.sideEffecting).toBe(true);
  });

  it("rejects a write CTE", async () => {
    await expectQueryDenied(
      "WITH changed AS (DELETE FROM accounts RETURNING id) SELECT * FROM changed",
    );
  });

  it("rejects SELECT INTO", async () => {
    await expectQueryDenied("SELECT * INTO copied_accounts FROM accounts", "PARAMS_INVALID");
  });

  it("denies EXPLAIN as unsupported in M-2", async () => {
    const adapter = new PostgresAdapter(config);
    const credentials = credentialsFor("postgres://unused:unused@127.0.0.1:1/unused");
    try {
      await expect(
        adapter.methods.query.execute(credentials, { sql: "EXPLAIN SELECT 1" }, context),
      ).rejects.toMatchObject({
        code: "SCOPE_DENIED",
        message: "postgres EXPLAIN is not supported in M-2",
      });
    } finally {
      await adapter.close();
    }
  });

  it("rejects pg_terminate_backend", async () => {
    await expectQueryDenied("SELECT pg_terminate_backend(1)");
  });

  it("rejects nextval", async () => {
    await expectQueryDenied("SELECT nextval('sequence_name')");
  });

  it("rejects pg_sleep", async () => {
    await expectQueryDenied("SELECT pg_sleep(1)");
  });

  it("rejects lo_import", async () => {
    await expectQueryDenied("SELECT lo_import('/etc/passwd')");
  });

  it("rejects dblink", async () => {
    await expectQueryDenied("SELECT dblink('dbname=test', 'SELECT 1')");
  });

  it("rejects multi-statement input", async () => {
    await expectQueryDenied("SELECT 1; DELETE FROM accounts", "PARAMS_INVALID");
  });

  it("rejects a comment-disguised write", async () => {
    await expectQueryDenied("DEL/**/ETE FROM accounts", "PARAMS_INVALID");
  });

  it("accepts comments containing write keywords", async () => {
    const adapter = new PostgresAdapter(config);
    const credentials = credentialsFor("postgres://unused:unused@127.0.0.1:1/unused");
    await expect(
      adapter.methods.query.execute(
        credentials,
        { sql: "SELECT 1 /* DELETE FROM accounts */" },
        context,
      ),
    ).rejects.toMatchObject({ code: "SERVICE_ERROR" });
    await adapter.close();
  });

  it("fails closed on parser failure", async () => {
    await expectQueryDenied("SELECT FROM", "PARAMS_INVALID");
  });

  it("rejects execute DDL", async () => {
    await expectExecuteDenied("CREATE TABLE denied (id integer)");
  });

  it("rejects execute TRUNCATE", async () => {
    await expectExecuteDenied("TRUNCATE accounts");
  });

  it("rejects execute COPY PROGRAM", async () => {
    await expectExecuteDenied("COPY accounts TO PROGRAM 'id'", "PARAMS_INVALID");
  });

  it("executes reads in a read-only transaction and writes only through execute", async () => {
    const fixture = await createPostgresFixture();
    const adapter = new PostgresAdapter(config);
    const credentials = credentialsFor(fixture.url);
    try {
      await fixture.sql.unsafe("CREATE ROLE caisson_reader LOGIN PASSWORD 'reader-test-only'");
      await fixture.sql.unsafe(
        "CREATE TABLE adapter_test (id integer PRIMARY KEY, value text NOT NULL)",
      );
      await fixture.sql.unsafe("GRANT SELECT ON adapter_test TO caisson_reader");
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
      ).resolves.toEqual({ rows: [{ id: 1, value: "one" }], truncated: false });
      const reader = postgres(fixture.url, {
        username: "caisson_reader",
        password: "reader-test-only",
      });
      try {
        await expect(
          reader.unsafe("UPDATE adapter_test SET value = 'blocked'"),
        ).rejects.toBeDefined();
      } finally {
        await reader.end({ timeout: 5 });
      }
    } finally {
      await adapter.close();
      await fixture.close();
    }
  }, 60_000);

  it("truncates after the configured row limit", async () => {
    const fixture = await createPostgresFixture();
    const adapter = new PostgresAdapter(config);
    try {
      await fixture.sql.unsafe("CREATE ROLE caisson_reader LOGIN PASSWORD 'reader-test-only'");
      const result = await adapter.methods.query.execute(
        credentialsFor(fixture.url),
        { sql: "SELECT n FROM generate_series(1, 3) AS n" },
        context,
      );
      expect(result).toEqual({ rows: [{ n: 1 }, { n: 2 }], truncated: true });
    } finally {
      await adapter.close();
      await fixture.close();
    }
  }, 60_000);

  it("enforces PostgreSQL statement_timeout", async () => {
    const fixture = await createPostgresFixture();
    const adapter = new PostgresAdapter({ ...config, statementTimeoutMs: 1 });
    try {
      await fixture.sql.unsafe("CREATE ROLE caisson_reader LOGIN PASSWORD 'reader-test-only'");
      await expect(
        adapter.methods.query.execute(
          credentialsFor(fixture.url),
          { sql: "SELECT count(*) FROM generate_series(1, 100000000)" },
          context,
        ),
      ).rejects.toMatchObject({ code: "SERVICE_ERROR" });
    } finally {
      await adapter.close();
      await fixture.close();
    }
  }, 60_000);

  it("rejects results beyond the configured serialized size cap", async () => {
    const fixture = await createPostgresFixture();
    const adapter = new PostgresAdapter({ ...config, resultSizeBytes: 8 });
    try {
      await fixture.sql.unsafe("CREATE ROLE caisson_reader LOGIN PASSWORD 'reader-test-only'");
      await expect(
        adapter.methods.query.execute(
          credentialsFor(fixture.url),
          { sql: "SELECT 'too-large' AS value" },
          context,
        ),
      ).rejects.toMatchObject({ code: "SERVICE_ERROR" });
    } finally {
      await adapter.close();
      await fixture.close();
    }
  }, 60_000);

  it("rejects missing or invalid adapter limits at registration", () => {
    expect(() => new PostgresAdapter(undefined as never)).toThrow("limits are required");
    expect(() => new PostgresAdapter({ ...config, rowLimit: 0 })).toThrow("positive integers");
  });
});

async function expectQueryDenied(sql: string, code = "SCOPE_DENIED") {
  const adapter = new PostgresAdapter(config);
  const credentials = credentialsFor("postgres://unused:unused@127.0.0.1:1/unused");
  try {
    await expect(
      adapter.methods.query.execute(credentials, { sql }, context),
    ).rejects.toMatchObject({ code });
  } finally {
    await adapter.close();
  }
}

async function expectExecuteDenied(sql: string, code = "SCOPE_DENIED") {
  const adapter = new PostgresAdapter(config);
  const credentials = credentialsFor("postgres://unused:unused@127.0.0.1:1/unused");
  try {
    await expect(
      adapter.methods.execute.execute(credentials, { sql }, context),
    ).rejects.toMatchObject({ code });
  } finally {
    await adapter.close();
  }
}

function credentialsFor(url: string) {
  const parsed = new URL(url);
  return {
    kind: "postgres" as const,
    host: parsed.hostname,
    port: Number(parsed.port),
    database: parsed.pathname.slice(1),
    username: new SecretString(decodeURIComponent(parsed.username)),
    password: new SecretString(decodeURIComponent(parsed.password)),
    readCredentials: {
      username: new SecretString("caisson_reader"),
      password: new SecretString("reader-test-only"),
    },
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
