import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  LocalSnapshot,
  ResolvedSnapshot,
  SnapshotObjectRef,
  SnapshotRef,
} from "@caisson/isolation";
import { CaissonError } from "@caisson/protocol";
import { z } from "zod";
import type {
  SessionSnapshotCrypto,
  WrappedSessionKek,
  WrappedSnapshotDek,
} from "./session-snapshot-crypto.js";
import type { ManifestKeyProvider, S3SnapshotStoreOptions } from "./snapshot-storage.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const objectSchema = z.object({
  bucket: z.string().min(1),
  key: z.string().min(1),
  versionId: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: z.number().int().positive(),
});
const manifestSchema = z.object({
  version: z.literal(1),
  snapshotId: z.string().uuid(),
  kind: z.literal("session"),
  sessionId: z.string().uuid(),
  baseSnapshotId: z.string().uuid(),
  createdAt: z.string().datetime(),
  keyId: z.string().min(1),
  artifacts: z
    .array(
      z.object({
        name: z.enum(["state", "memory"]),
        object: objectSchema,
        compressedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        compressedSizeBytes: z.number().int().positive(),
        plainSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        plainSizeBytes: z.number().int().positive(),
        nonce: z.string().regex(/^[A-Za-z0-9_-]+$/u),
        tag: z.string().regex(/^[A-Za-z0-9_-]+$/u),
      }),
    )
    .length(2),
  signature: z.string().regex(/^[a-f0-9]{64}$/u),
});
type SessionManifest = z.infer<typeof manifestSchema>;
type SessionArtifact = SessionManifest["artifacts"][number];

export interface SessionSnapshotStoreOptions extends S3SnapshotStoreOptions {
  readonly crypto: SessionSnapshotCrypto;
}

/** Signed, encrypted per-session snapshot persistence. It never promotes a session snapshot. */
export class S3SessionSnapshotStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #cacheDirectory: string;
  readonly #manifestKeys: ManifestKeyProvider;
  readonly #crypto: SessionSnapshotCrypto;

  constructor(options: SessionSnapshotStoreOptions) {
    this.#bucket = options.bucket;
    this.#cacheDirectory = options.cacheDirectory;
    this.#manifestKeys = options.manifestKeys;
    this.#crypto = options.crypto;
    this.#client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  async store(
    local: LocalSnapshot,
    input: {
      sessionId: string;
      baseSnapshotId: string;
      sessionKek: WrappedSessionKek;
      snapshotDek: WrappedSnapshotDek;
    },
  ): Promise<SnapshotRef> {
    if (local.kind !== "session")
      throw new CaissonError(
        "SANDBOX_FAILED",
        "session snapshot store requires a session snapshot",
      );
    await this.#ensureBucket();
    const key = await this.#manifestKeys.active();
    const prefix = `snapshots/session/${input.sessionId}/${local.id}`;
    const artifacts = await Promise.all([
      this.#upload(
        prefix,
        "state",
        local.statePath,
        input.sessionId,
        local.id,
        input.sessionKek,
        input.snapshotDek,
      ),
      this.#upload(
        prefix,
        "memory",
        local.memoryPath,
        input.sessionId,
        local.id,
        input.sessionKek,
        input.snapshotDek,
      ),
    ]);
    const unsigned = {
      version: 1 as const,
      snapshotId: local.id,
      kind: "session" as const,
      sessionId: input.sessionId,
      baseSnapshotId: input.baseSnapshotId,
      createdAt: local.createdAt,
      keyId: key.keyId,
      artifacts,
    };
    const body = Buffer.from(JSON.stringify({ ...unsigned, signature: sign(unsigned, key.bytes) }));
    const manifest = await this.#put(`${prefix}/manifest.json`, body);
    return {
      id: local.id,
      kind: "session",
      manifest,
      manifestKeyId: key.keyId,
      createdAt: local.createdAt,
      sessionId: input.sessionId,
      baseSnapshotId: input.baseSnapshotId,
    };
  }

  async resolve(
    ref: SnapshotRef,
    input: {
      sessionId: string;
      sessionKek: WrappedSessionKek;
      snapshotDek: WrappedSnapshotDek;
      base: ResolvedSnapshot;
    },
  ): Promise<ResolvedSnapshot> {
    if (
      ref.kind !== "session" ||
      ref.sessionId !== input.sessionId ||
      ref.baseSnapshotId !== input.base.ref.id
    ) {
      throw new CaissonError("SANDBOX_FAILED", "session snapshot restore lineage is invalid");
    }
    const manifest = await this.#readManifest(ref);
    if (
      manifest.snapshotId !== ref.id ||
      manifest.sessionId !== input.sessionId ||
      manifest.baseSnapshotId !== input.base.ref.id
    ) {
      throw new CaissonError("SANDBOX_FAILED", "session snapshot manifest lineage is invalid");
    }
    const destination = join(this.#cacheDirectory, "session-snapshots", ref.id);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    try {
      for (const artifact of manifest.artifacts) {
        const encrypted = await this.#download(toObjectRef(artifact.object));
        const aad = aadFor(manifest.sessionId, manifest.snapshotId, artifact.name);
        const compressed = await this.#crypto.decrypt(
          { nonce: fromUrl64(artifact.nonce), tag: fromUrl64(artifact.tag), ciphertext: encrypted },
          input.sessionKek,
          input.snapshotDek,
          aad,
        );
        if (
          compressed.byteLength !== artifact.compressedSizeBytes ||
          hash(compressed) !== artifact.compressedSha256
        ) {
          throw new CaissonError(
            "SANDBOX_FAILED",
            "session snapshot compressed artifact integrity verification failed",
          );
        }
        const plain = await gunzipAsync(compressed);
        if (plain.byteLength !== artifact.plainSizeBytes || hash(plain) !== artifact.plainSha256) {
          throw new CaissonError(
            "SANDBOX_FAILED",
            "session snapshot artifact integrity verification failed",
          );
        }
        await writeFile(join(temporary, artifact.name), plain, { flag: "wx", mode: 0o600 });
      }
      await writeFile(join(temporary, ".complete"), "verified\n", { flag: "wx", mode: 0o600 });
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      try {
        await stat(destination);
        await rm(temporary, { recursive: true, force: true });
      } catch {
        await rename(temporary, destination);
      }
      return {
        ref,
        statePath: join(destination, "state"),
        memoryPath: join(destination, "memory"),
        ...(input.base.rootfsPath === undefined ? {} : { rootfsPath: input.base.rootfsPath }),
        ...(input.base.kernelPath === undefined ? {} : { kernelPath: input.base.kernelPath }),
      };
    } catch (error: unknown) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async deleteObjects(ref: SnapshotRef): Promise<void> {
    if (ref.kind !== "session")
      throw new CaissonError("SANDBOX_FAILED", "only session snapshots may be deleted");
    const manifest = await this.#readManifest(ref);
    for (const artifact of manifest.artifacts) {
      await this.#client.send(
        new DeleteObjectCommand({ Bucket: artifact.object.bucket, Key: artifact.object.key }),
      );
    }
    // The authenticated manifest is the retry plan, so it is always deleted
    // last, after every artifact deletion has succeeded.
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: ref.manifest.bucket, Key: ref.manifest.key }),
    );
  }

  async #ensureBucket(): Promise<void> {
    try {
      await this.#client.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    } catch (error: unknown) {
      const name = (error as { name?: unknown }).name;
      if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw error;
    }
  }

  async #upload(
    prefix: string,
    name: "state" | "memory",
    path: string,
    sessionId: string,
    snapshotId: string,
    sessionKek: WrappedSessionKek,
    snapshotDek: WrappedSnapshotDek,
  ): Promise<SessionArtifact> {
    const plain = await readFile(path);
    const compressed = await gzipAsync(plain);
    const encrypted = await this.#crypto.encrypt(
      compressed,
      sessionKek,
      snapshotDek,
      aadFor(sessionId, snapshotId, name),
    );
    return {
      name,
      object: await this.#put(`${prefix}/${name}.bin`, encrypted.ciphertext),
      compressedSha256: hash(compressed),
      compressedSizeBytes: compressed.byteLength,
      plainSha256: hash(plain),
      plainSizeBytes: plain.byteLength,
      nonce: toUrl64(encrypted.nonce),
      tag: toUrl64(encrypted.tag),
    };
  }

  async #put(key: string, body: Buffer): Promise<SnapshotObjectRef> {
    const put = await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ServerSideEncryption: "AES256",
      }),
    );
    const head = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
    if (head.ServerSideEncryption !== "AES256")
      throw new CaissonError(
        "SANDBOX_FAILED",
        "snapshot object server-side encryption was not confirmed",
      );
    return {
      bucket: this.#bucket,
      key,
      ...(put.VersionId === undefined ? {} : { versionId: put.VersionId }),
      sha256: hash(body),
      sizeBytes: body.byteLength,
    };
  }

  async #readManifest(ref: SnapshotRef): Promise<SessionManifest> {
    const raw = await this.#download(ref.manifest);
    let value: unknown;
    try {
      value = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new CaissonError("SANDBOX_FAILED", "session snapshot manifest is invalid");
    }
    const parsed = manifestSchema.safeParse(value);
    if (!parsed.success)
      throw new CaissonError("SANDBOX_FAILED", "session snapshot manifest is invalid");
    const { signature, ...unsigned } = parsed.data;
    const key = await this.#manifestKeys.resolve(parsed.data.keyId);
    const expected = Buffer.from(sign(unsigned, key.bytes), "hex");
    const actual = Buffer.from(signature, "hex");
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual))
      throw new CaissonError("SANDBOX_FAILED", "session snapshot manifest authentication failed");
    return parsed.data;
  }

  async #download(object: SnapshotObjectRef): Promise<Buffer> {
    const response = await this.#client.send(
      new GetObjectCommand({
        Bucket: object.bucket,
        Key: object.key,
        ...(object.versionId === undefined ? {} : { VersionId: object.versionId }),
      }),
    );
    if (response.Body === undefined)
      throw new CaissonError("SANDBOX_FAILED", "snapshot object is empty");
    const body = Buffer.from(await response.Body.transformToByteArray());
    if (body.byteLength !== object.sizeBytes || hash(body) !== object.sha256)
      throw new CaissonError("SANDBOX_FAILED", "snapshot object integrity verification failed");
    return body;
  }
}

function hash(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function sign(value: object, key: Buffer): string {
  return createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
}
function aadFor(sessionId: string, snapshotId: string, name: string): Buffer {
  return Buffer.from(`caisson/session-snapshot/${sessionId}/${snapshotId}/${name}`, "utf8");
}
function toUrl64(value: Buffer): string {
  return value.toString("base64url");
}
function fromUrl64(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
function toObjectRef(value: z.infer<typeof objectSchema>): SnapshotObjectRef {
  return {
    bucket: value.bucket,
    key: value.key,
    ...(value.versionId === undefined ? {} : { versionId: value.versionId }),
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
  };
}
