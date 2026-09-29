import { inspect } from "node:util";

import { CaissonError } from "@caisson/protocol";
import { z } from "zod";

const REDACTED = "[redacted]";

export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export const SslModeSchema = z.enum(["verify-full", "require", "disable"]);
export type SslMode = z.infer<typeof SslModeSchema>;

export interface PostgresCredentials {
  readonly kind: "postgres";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: SecretString;
  readonly password: SecretString;
  readonly sslMode: SslMode;
  readonly readCredentials: { readonly username: SecretString; readonly password: SecretString };
}

export type Credentials = PostgresCredentials;

const StoredPostgresCredentialsSchema = z
  .object({
    kind: z.literal("postgres"),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    database: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    readCredentials: z
      .object({ username: z.string().min(1), password: z.string().min(1) })
      .strict(),
    sslMode: SslModeSchema.default("verify-full"),
  })
  .strict();

export function parseCredentials(value: unknown, environment: string | undefined): Credentials {
  const parsed = StoredPostgresCredentialsSchema.safeParse(value);
  if (!parsed.success || (parsed.data.sslMode === "disable" && environment === "production")) {
    throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
  }
  return {
    kind: "postgres",
    host: parsed.data.host,
    port: parsed.data.port,
    database: parsed.data.database,
    username: new SecretString(parsed.data.username),
    password: new SecretString(parsed.data.password),
    readCredentials: {
      username: new SecretString(parsed.data.readCredentials.username),
      password: new SecretString(parsed.data.readCredentials.password),
    },
    sslMode: parsed.data.sslMode,
  };
}
