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

export interface S3Credentials {
  readonly kind: "s3";
  readonly accessKeyId: SecretString;
  readonly secretAccessKey: SecretString;
}

/** A host-only wrapping key for encrypted per-session snapshot DEKs. */
export interface SnapshotKekCredentials {
  readonly kind: "snapshot_kek";
  readonly keyId: string;
  readonly key: SecretString;
}

export type Credentials = PostgresCredentials | S3Credentials | SnapshotKekCredentials;

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

const StoredS3CredentialsSchema = z
  .object({
    kind: z.literal("s3"),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
  })
  .strict();

const StoredSnapshotKekCredentialsSchema = z
  .object({
    kind: z.literal("snapshot_kek"),
    keyId: z.string().min(1).max(128),
    /** Base64-encoded, at least 256 bits after decoding. */
    key: z.string().min(1),
  })
  .strict();

const StoredCredentialsSchema = z.discriminatedUnion("kind", [
  StoredPostgresCredentialsSchema,
  StoredS3CredentialsSchema,
  StoredSnapshotKekCredentialsSchema,
]);

export function parseCredentials(value: unknown, environment: string | undefined): Credentials {
  const parsed = StoredCredentialsSchema.safeParse(value);
  if (!parsed.success) {
    throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
  }
  if (parsed.data.kind === "s3") {
    return {
      kind: "s3",
      accessKeyId: new SecretString(parsed.data.accessKeyId),
      secretAccessKey: new SecretString(parsed.data.secretAccessKey),
    };
  }
  if (parsed.data.kind === "snapshot_kek") {
    const bytes = Buffer.from(parsed.data.key, "base64");
    if (bytes.byteLength !== 32) {
      throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
    }
    return {
      kind: "snapshot_kek",
      keyId: parsed.data.keyId,
      key: new SecretString(parsed.data.key),
    };
  }
  if (parsed.data.sslMode === "disable" && environment === "production") {
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
