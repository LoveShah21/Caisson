import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CaissonError } from "@caisson/protocol";
import type { S3Credentials } from "@caisson/secrets";
import { z } from "zod";

import { BinaryContentSchema, decodeContent, encodeContent } from "./binary-content.js";
import type { CallContext } from "./postgres-adapter.js";

const BucketKeySchema = z.object({ bucket: z.string().min(1), key: z.string().min(1) }).strict();
const PutObjectSchema = BucketKeySchema.extend({
  body: BinaryContentSchema,
  contentType: z.string().min(1).max(512).optional(),
}).strict();
const ListObjectsSchema = z.object({ bucket: z.string().min(1), prefix: z.string() }).strict();

export interface S3AllowlistEntry {
  readonly bucket: string;
  readonly prefix: string;
}

export interface S3AdapterConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly forcePathStyle: boolean;
  readonly allowlist: readonly S3AllowlistEntry[];
  readonly timeoutMs: number;
  readonly objectSizeBytes: number;
  readonly listLimit: number;
}

export interface S3ObjectResult {
  readonly encoding: "utf8" | "base64";
  readonly data: string;
  readonly contentType?: string;
  readonly size: number;
}

export class S3Adapter {
  readonly name = "s3";
  readonly #config: S3AdapterConfig;
  readonly #clients = new Map<string, S3Client>();

  constructor(config: S3AdapterConfig) {
    assertConfig(config);
    this.#config = config;
  }

  readonly methods = {
    getObject: {
      params: BucketKeySchema,
      scopeRequired: "s3.read",
      sideEffecting: false,
      summarise: (): string => "read an allowlisted S3 object",
      execute: async (credentials: S3Credentials, params: unknown, context: CallContext) =>
        this.#getObject(credentials, params, context),
    },
    putObject: {
      params: PutObjectSchema,
      scopeRequired: "s3.write",
      sideEffecting: true,
      summarise: (): string => "write an allowlisted S3 object",
      execute: async (credentials: S3Credentials, params: unknown, context: CallContext) =>
        this.#putObject(credentials, params, context),
    },
    deleteObject: {
      params: BucketKeySchema,
      scopeRequired: "s3.delete",
      sideEffecting: true,
      summarise: (): string => "delete an allowlisted S3 object",
      execute: async (credentials: S3Credentials, params: unknown, context: CallContext) =>
        this.#deleteObject(credentials, params, context),
    },
    listObjects: {
      params: ListObjectsSchema,
      scopeRequired: "s3.read",
      sideEffecting: false,
      summarise: (): string => "list allowlisted S3 objects",
      execute: async (credentials: S3Credentials, params: unknown, context: CallContext) =>
        this.#listObjects(credentials, params, context),
    },
  } as const;

  destroy(): void {
    for (const client of this.#clients.values()) client.destroy();
    this.#clients.clear();
  }

  async #getObject(
    credentials: S3Credentials,
    params: unknown,
    context: CallContext,
  ): Promise<S3ObjectResult> {
    const input = parseParams(BucketKeySchema, params);
    assertS3Credentials(credentials);
    assertKeyAllowed(input.bucket, input.key, this.#config.allowlist);
    try {
      const response = await this.#client(credentials).send(
        new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
        { abortSignal: timeoutSignal(context.timeoutMs, this.#config.timeoutMs) },
      );
      const bytes = await readBody(response.Body, this.#config.objectSizeBytes);
      const content = encodeContent(bytes, response.ContentType);
      return response.ContentType === undefined
        ? { ...content, size: bytes.length }
        : { ...content, contentType: response.ContentType, size: bytes.length };
    } catch (error: unknown) {
      throw serviceError(error);
    }
  }

  async #putObject(
    credentials: S3Credentials,
    params: unknown,
    context: CallContext,
  ): Promise<void> {
    const input = parseParams(PutObjectSchema, params);
    assertS3Credentials(credentials);
    assertKeyAllowed(input.bucket, input.key, this.#config.allowlist);
    const body = decodeContent(input.body, this.#config.objectSizeBytes);
    try {
      await this.#client(credentials).send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: body,
          ...(input.contentType === undefined ? {} : { ContentType: input.contentType }),
        }),
        { abortSignal: timeoutSignal(context.timeoutMs, this.#config.timeoutMs) },
      );
    } catch (error: unknown) {
      throw serviceError(error);
    }
  }

  async #deleteObject(
    credentials: S3Credentials,
    params: unknown,
    context: CallContext,
  ): Promise<void> {
    const input = parseParams(BucketKeySchema, params);
    assertS3Credentials(credentials);
    assertKeyAllowed(input.bucket, input.key, this.#config.allowlist);
    try {
      await this.#client(credentials).send(
        new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }),
        { abortSignal: timeoutSignal(context.timeoutMs, this.#config.timeoutMs) },
      );
    } catch (error: unknown) {
      throw serviceError(error);
    }
  }

  async #listObjects(
    credentials: S3Credentials,
    params: unknown,
    context: CallContext,
  ): Promise<{ readonly keys: readonly string[] }> {
    const input = parseParams(ListObjectsSchema, params);
    assertS3Credentials(credentials);
    assertPrefixAllowed(input.bucket, input.prefix, this.#config.allowlist);
    try {
      const response = await this.#client(credentials).send(
        new ListObjectsV2Command({
          Bucket: input.bucket,
          Prefix: input.prefix,
          MaxKeys: this.#config.listLimit,
        }),
        { abortSignal: timeoutSignal(context.timeoutMs, this.#config.timeoutMs) },
      );
      if (response.IsTruncated) {
        throw new CaissonError("SERVICE_ERROR", "S3 list exceeds configured limit");
      }
      const result = {
        keys:
          response.Contents?.flatMap((item) => (item.Key === undefined ? [] : [item.Key])) ?? [],
      };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > this.#config.objectSizeBytes) {
        throw new CaissonError("SERVICE_ERROR", "S3 list response exceeds configured size limit");
      }
      return result;
    } catch (error: unknown) {
      throw serviceError(error);
    }
  }

  #client(credentials: S3Credentials): S3Client {
    const key = `${credentials.accessKeyId.reveal()}@${this.#config.endpoint}`;
    const existing = this.#clients.get(key);
    if (existing !== undefined) return existing;
    const client = new S3Client({
      endpoint: this.#config.endpoint,
      region: this.#config.region,
      forcePathStyle: this.#config.forcePathStyle,
      credentials: {
        accessKeyId: credentials.accessKeyId.reveal(),
        secretAccessKey: credentials.secretAccessKey.reveal(),
      },
    });
    this.#clients.set(key, client);
    return client;
  }
}

function assertConfig(config: S3AdapterConfig): void {
  if (config === undefined || config === null || typeof config !== "object") {
    throw new CaissonError("PARAMS_INVALID", "S3 adapter configuration is required");
  }
  try {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error();
  } catch {
    throw new CaissonError("PARAMS_INVALID", "S3 endpoint is invalid");
  }
  if (
    config.region.length === 0 ||
    config.allowlist.length === 0 ||
    typeof config.forcePathStyle !== "boolean"
  ) {
    throw new CaissonError("PARAMS_INVALID", "S3 adapter configuration is invalid");
  }
  for (const value of [config.timeoutMs, config.objectSizeBytes, config.listLimit]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CaissonError("PARAMS_INVALID", "S3 adapter limits must be positive integers");
    }
  }
  for (const entry of config.allowlist) {
    assertKey(entry.prefix, "S3 allowlist prefix is invalid");
  }
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new CaissonError("PARAMS_INVALID", "invalid S3 request parameters");
  return parsed.data;
}

function assertS3Credentials(credentials: unknown): asserts credentials is S3Credentials {
  if (
    typeof credentials !== "object" ||
    credentials === null ||
    (credentials as { kind?: unknown }).kind !== "s3"
  ) {
    throw new CaissonError("SECRET_UNAVAILABLE", "S3 credentials unavailable");
  }
}

function assertKeyAllowed(
  bucket: string,
  key: string,
  allowlist: readonly S3AllowlistEntry[],
): void {
  assertKey(key, "S3 key is invalid");
  if (!allowlist.some((entry) => entry.bucket === bucket && key.startsWith(entry.prefix))) {
    throw new CaissonError("SCOPE_DENIED", "S3 bucket or key is not allowlisted");
  }
}

function assertPrefixAllowed(
  bucket: string,
  prefix: string,
  allowlist: readonly S3AllowlistEntry[],
): void {
  assertKey(prefix, "S3 prefix is invalid");
  if (!allowlist.some((entry) => entry.bucket === bucket && prefix.startsWith(entry.prefix))) {
    throw new CaissonError("SCOPE_DENIED", "S3 bucket or prefix is not allowlisted");
  }
}

function assertKey(value: string, message: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new CaissonError("PARAMS_INVALID", message);
  }
  if (
    value.startsWith("/") ||
    decoded.startsWith("/") ||
    value.includes("\\") ||
    decoded.includes("\\") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new CaissonError("PARAMS_INVALID", message);
  }
}

function timeoutSignal(requestTimeoutMs: number, adapterTimeoutMs: number): AbortSignal {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new CaissonError("SERVICE_TIMEOUT", "S3 timeout must be positive");
  }
  return AbortSignal.timeout(Math.min(requestTimeoutMs, adapterTimeoutMs));
}

async function readBody(body: unknown, maximumBytes: number): Promise<Buffer> {
  if (body === undefined || body === null || !(Symbol.asyncIterator in Object(body))) {
    throw new CaissonError("SERVICE_ERROR", "S3 response body is unavailable");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maximumBytes) {
      throw new CaissonError("SERVICE_ERROR", "S3 object exceeds configured size limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function serviceError(error: unknown): CaissonError {
  if (error instanceof CaissonError) return error;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new CaissonError("SERVICE_TIMEOUT", "S3 request timed out");
  }
  return new CaissonError("SERVICE_ERROR", "S3 request failed");
}
