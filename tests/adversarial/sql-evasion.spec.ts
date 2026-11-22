import { afterAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "../../apps/broker/src/postgres-adapter.js";
import { SecretString } from "../../packages/secrets/src/credentials.js";

const adapter = new PostgresAdapter({
  statementTimeoutMs: 1_000,
  rowLimit: 2,
  resultSizeBytes: 1_024,
});

const credentials = {
  kind: "postgres" as const,
  host: "127.0.0.1",
  port: 1,
  database: "unused",
  username: new SecretString("unused"),
  password: new SecretString("unused"),
  readCredentials: {
    username: new SecretString("caisson_reader"),
    password: new SecretString("unused"),
  },
  sslMode: "disable" as const,
};

afterAll(async () => {
  await adapter.close();
});

describe("adversarial SQL evasion", () => {
  it.each([
    ["write CTE", "WITH changed AS (DELETE FROM accounts RETURNING id) SELECT * FROM changed"],
    ["SELECT INTO", "SELECT 1 INTO copied_accounts"],
    ["multiple statements", "SELECT 1; DELETE FROM accounts"],
    ["comment disguised write", "DEL/**/ETE FROM accounts"],
    ["side effect function", "SELECT pg_terminate_backend(1)"],
    ["sequence mutation", "SELECT nextval('sequence_name')"],
    ["EXPLAIN ANALYZE", "EXPLAIN ANALYZE SELECT pg_sleep(1)"],
    ["parser failure", "SELECT FROM"],
  ])("denies %s before opening a database connection", async (_name, sql) => {
    await expect(
      adapter.methods.query.execute(credentials, { sql }, { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(SCOPE_DENIED|PARAMS_INVALID)$/) });
  });
});
