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

export class PostgresAdapter {
  readonly name = "postgres";
  readonly #clients = new Map<string, Sql>();

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
      this.#client(credentials).begin(async (transaction) => {
        await transaction.unsafe("SET TRANSACTION READ ONLY");
        return transaction.unsafe(input.data.sql, input.data.parameters);
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
    return this.#withinTimeout(context.timeoutMs, async () =>
      this.#client(credentials).unsafe(input.data.sql, input.data.parameters),
    );
  }

  #client(credentials: PostgresCredentials): Sql {
    const key = `${credentials.host}:${credentials.port}/${credentials.database}:${credentials.username.reveal()}:${credentials.sslMode}`;
    const existing = this.#clients.get(key);
    if (existing !== undefined) return existing;
    const client = postgres({
      host: credentials.host,
      port: credentials.port,
      database: credentials.database,
      username: credentials.username.reveal(),
      password: credentials.password.reveal(),
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
  const statement = assertOneStatement(sql);
  if (!isReadOnlyStatement(statement)) {
    throw new CaissonError("SCOPE_DENIED", "postgres query accepts one read-only statement");
  }
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
