import { CaissonError } from "@caisson/protocol";
import type { PostgresCredentials } from "@caisson/secrets";
import { parse } from "pgsql-ast-parser";
import postgres, { type Sql } from "postgres";
import { z } from "zod";

const SqlParamsSchema = z
  .object({
    sql: z.string().min(1),
    parameters: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([]),
  })
  .strict();

export interface AdapterMethod {
  readonly params: typeof SqlParamsSchema;
  readonly scopeRequired: "warehouse.readonly" | "warehouse.write";
  readonly sideEffecting: boolean;
  summarise(params: unknown): string;
  execute(
    credentials: PostgresCredentials,
    params: unknown,
    context: CallContext,
  ): Promise<unknown>;
}

export interface CallContext {
  readonly timeoutMs: number;
}
export interface PostgresAdapterConfig {
  readonly statementTimeoutMs: number;
  readonly rowLimit: number;
  readonly resultSizeBytes: number;
}
export interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
}

export class PostgresAdapter {
  readonly name = "postgres";
  readonly #clients = new Map<string, Sql>();
  readonly #config: PostgresAdapterConfig;

  constructor(config: PostgresAdapterConfig) {
    if (config === undefined || config === null || typeof config !== "object") {
      throw new CaissonError("PARAMS_INVALID", "postgres adapter limits are required");
    }
    for (const value of [config.statementTimeoutMs, config.rowLimit, config.resultSizeBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new CaissonError(
          "PARAMS_INVALID",
          "postgres adapter limits must be positive integers",
        );
      }
    }
    this.#config = config;
  }

  readonly methods: Readonly<Record<"query" | "execute", AdapterMethod>> = {
    query: {
      params: SqlParamsSchema,
      scopeRequired: "warehouse.readonly",
      sideEffecting: false,
      summarise: summarise,
      execute: async (credentials, params, context) => this.#query(credentials, params, context),
    },
    execute: {
      params: SqlParamsSchema,
      scopeRequired: "warehouse.write",
      sideEffecting: true,
      summarise: summarise,
      execute: async (credentials, params, context) => this.#execute(credentials, params, context),
    },
  };

  async close(): Promise<void> {
    await Promise.all(
      [...this.#clients.values()].map(async (client) => client.end({ timeout: 5 })),
    );
    this.#clients.clear();
  }

  async #query(
    credentials: PostgresCredentials,
    params: unknown,
    context: CallContext,
  ): Promise<unknown> {
    const input = SqlParamsSchema.safeParse(params);
    if (!input.success) throw new CaissonError("PARAMS_INVALID", "invalid postgres parameters");
    assertReadOnlyStatement(input.data.sql);
    return this.#withinTimeout(context.timeoutMs, async () =>
      this.#client(credentials, true).begin(async (transaction) => {
        await transaction.unsafe("SET TRANSACTION READ ONLY");
        await transaction.unsafe(
          `SET LOCAL statement_timeout = ${this.#config.statementTimeoutMs}`,
        );
        const rows = await transaction.unsafe(
          `SELECT * FROM (${input.data.sql}) AS caisson_limited LIMIT ${this.#config.rowLimit + 1}`,
          input.data.parameters,
        );
        const result: QueryResult = {
          rows: rows.slice(0, this.#config.rowLimit),
          truncated: rows.length > this.#config.rowLimit,
        };
        if (Buffer.byteLength(JSON.stringify(result)) > this.#config.resultSizeBytes) {
          throw new CaissonError("SERVICE_ERROR", "postgres result exceeds configured size limit");
        }
        return result;
      }),
    );
  }

  async #execute(
    credentials: PostgresCredentials,
    params: unknown,
    context: CallContext,
  ): Promise<unknown> {
    const input = SqlParamsSchema.safeParse(params);
    if (!input.success) throw new CaissonError("PARAMS_INVALID", "invalid postgres parameters");
    assertOneStatement(input.data.sql);
    assertDmlStatement(input.data.sql);
    return this.#withinTimeout(context.timeoutMs, async () =>
      this.#client(credentials).unsafe(input.data.sql, input.data.parameters),
    );
  }

  #client(credentials: PostgresCredentials, readOnly = false): Sql {
    const username = readOnly ? credentials.readCredentials.username : credentials.username;
    const password = readOnly ? credentials.readCredentials.password : credentials.password;
    const key = `${credentials.host}:${credentials.port}/${credentials.database}:${username.reveal()}:${credentials.sslMode}`;
    const existing = this.#clients.get(key);
    if (existing !== undefined) return existing;
    const client = postgres({
      host: credentials.host,
      port: credentials.port,
      database: credentials.database,
      username: username.reveal(),
      password: password.reveal(),
      ssl:
        credentials.sslMode === "disable"
          ? false
          : { rejectUnauthorized: credentials.sslMode === "verify-full" },
      max: 10,
    });
    this.#clients.set(key, client);
    return client;
  }

  async #withinTimeout<T>(timeoutMs: number, operation: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new CaissonError("SERVICE_TIMEOUT", "postgres timeout must be positive");
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CaissonError("SERVICE_TIMEOUT", "postgres call timed out")),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([operation(), timeout]);
    } catch (error: unknown) {
      if (error instanceof CaissonError) throw error;
      throw new CaissonError("SERVICE_ERROR", "postgres operation failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function summarise(params: unknown): string {
  const input = SqlParamsSchema.safeParse(params);
  return input.success ? "execute a PostgreSQL statement" : "invalid PostgreSQL statement";
}

function assertReadOnlyStatement(sql: string): void {
  if (/^\s*explain\b/iu.test(sql)) {
    throw new CaissonError("SCOPE_DENIED", "postgres EXPLAIN is not supported in M-2");
  }
  const statement = assertOneStatement(sql);
  if (!isReadOnlyStatement(statement) || hasSideEffectingFunction(statement)) {
    throw new CaissonError("SCOPE_DENIED", "postgres query accepts one read-only statement");
  }
}

function assertDmlStatement(sql: string): void {
  const statement = assertOneStatement(sql) as { type?: unknown };
  if (statement.type !== "insert" && statement.type !== "update" && statement.type !== "delete") {
    throw new CaissonError(
      "SCOPE_DENIED",
      "postgres execute accepts INSERT, UPDATE, or DELETE only",
    );
  }
}

function hasSideEffectingFunction(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some(hasSideEffectingFunction);
  const record = value as Record<string, unknown>;
  const name = (record["function"] as { name?: unknown } | undefined)?.name;
  if (
    record["type"] === "call" &&
    typeof name === "string" &&
    /^(pg_terminate_backend|nextval|pg_sleep|lo_import|dblink(?:_|$))/iu.test(name)
  ) {
    return true;
  }
  return Object.values(record).some(hasSideEffectingFunction);
}

function assertOneStatement(sql: string): unknown {
  try {
    const statements = parse(sql);
    if (statements.length !== 1)
      throw new CaissonError("PARAMS_INVALID", "postgres accepts one statement");
    return statements[0];
  } catch (error: unknown) {
    if (error instanceof CaissonError) throw error;
    throw new CaissonError("PARAMS_INVALID", "postgres statement could not be parsed");
  }
}

function isReadOnlyStatement(statement: unknown): boolean {
  if (typeof statement !== "object" || statement === null) return false;
  const value = statement as { readonly type?: unknown; readonly with?: unknown };
  if (value.type !== "select") return false;
  if (!Array.isArray(value.with)) return true;
  return value.with.every((cte) => {
    if (typeof cte !== "object" || cte === null) return false;
    return isReadOnlyStatement((cte as { readonly statement?: unknown }).statement);
  });
}
