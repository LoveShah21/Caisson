import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import {
  CreateBucketCommand,
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

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const MINIMUM_HMAC_BYTES = 32;

export interface ManifestKey {
  readonly keyId: string;
  readonly bytes: Buffer;
}

export interface ManifestKeyProvider {
  resolve(keyId: string): Promise<ManifestKey>;
  active(): Promise<ManifestKey>;
}

export class EnvManifestKeyProvider implements ManifestKeyProvider {
  readonly #key: ManifestKey;

  constructor(keyId: string, encodedKey: string) {
    const bytes = Buffer.from(encodedKey, "base64");
    if (!keyId || bytes.byteLength < MINIMUM_HMAC_BYTES) {
      throw new CaissonError("SANDBOX_FAILED", "snapshot manifest key configuration is invalid");
    }
    this.#key = { keyId, bytes };
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): EnvManifestKeyProvider {
    // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv is index-signature-only under strict TS.
    const keyId = environment["CAISSON_SNAPSHOT_MANIFEST_KEY_ID"];
    // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv is index-signature-only under strict TS.
    const encodedKey = environment["CAISSON_SNAPSHOT_MANIFEST_HMAC_KEY"];
    if (keyId === undefined || encodedKey === undefined) {
      throw new CaissonError("SANDBOX_FAILED", "snapshot manifest key configuration is missing");
    }
    return new EnvManifestKeyProvider(keyId, encodedKey);
  }

  async active(): Promise<ManifestKey> {
    return this.#key;
  }

  async resolve(keyId: string): Promise<ManifestKey> {
    if (keyId !== this.#key.keyId) {
      throw new CaissonError("SANDBOX_FAILED", "snapshot manifest key is unavailable");
    }
    return this.#key;
  }
}

const snapshotObjectRefSchema = z.object({
  bucket: z.string().min(1),
  key: z.string().min(1),
  versionId: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: z.number().int().positive(),
});

const snapshotManifestSchema = z.object({
  version: z.literal(1),
  snapshotId: z.string().min(1),
  kind: z.literal("base"),
  createdAt: z.string().datetime(),
  keyId: z.string().min(1),
  artifacts: z
    .array(
      z.object({
        name: z.enum(["state", "memory", "rootfs", "kernel"]),
        object: snapshotObjectRefSchema,
        uncompressedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        uncompressedSizeBytes: z.number().int().positive(),
        compression: z.literal("gzip"),
      }),
    )
    .length(4)
    .refine(
      (artifacts) => new Set(artifacts.map((artifact) => artifact.name)).size === artifacts.length,
      "snapshot artifacts must have unique names",
    ),
  rootfsRestorePath: z.string().min(1),
  signature: z.string().regex(/^[a-f0-9]{64}$/u),
});

type ManifestArtifact = z.infer<typeof snapshotManifestSchema>["artifacts"][number];
type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

export interface S3SnapshotStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly cacheDirectory: string;
  readonly cacheMaxBytes: number;
  readonly manifestKeys: ManifestKeyProvider;
}

/** Stores only clean base snapshots. Per-session snapshots remain FR-16 work. */
export class S3BaseSnapshotStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #cacheDirectory: string;
  readonly #cacheMaxBytes: number;
  readonly #manifestKeys: ManifestKeyProvider;
  readonly #pinned = new Set<string>();
  readonly #inUse = new Set<string>();
  readonly #rootfsBySnapshot = new Map<string, string>();

  constructor(options: S3SnapshotStoreOptions) {
    if (!Number.isSafeInteger(options.cacheMaxBytes) || options.cacheMaxBytes <= 0) {
      throw new CaissonError("SANDBOX_FAILED", "snapshot cache size configuration is invalid");
    }
    this.#bucket = options.bucket;
    this.#cacheDirectory = options.cacheDirectory;
    this.#cacheMaxBytes = options.cacheMaxBytes;
    this.#manifestKeys = options.manifestKeys;
    this.#client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  static cacheMaxBytesFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
    // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv is index-signature-only under strict TS.
    const raw = environment["CAISSON_SNAPSHOT_CACHE_MAX_BYTES"];
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "snapshot cache size configuration is missing or invalid",
      );
    }
    return parsed;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.#client.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        !/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(error.name)
      ) {
        throw error;
      }
    }
  }

  async storeBase(local: LocalSnapshot): Promise<SnapshotRef> {
    if (local.kind !== "base" || local.rootfsPath === undefined || local.kernelPath === undefined) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "base snapshot requires state, memory, rootfs, and kernel artifacts",
      );
    }
    if (local.rootfsPath.endsWith("m1-dev-probe-rootfs.ext4")) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "the M-1 development probe rootfs is ineligible for base snapshot storage",
      );
    }
    await this.ensureBucket();
    const key = await this.#manifestKeys.active();
    const prefix = `snapshots/base/${local.id}`;
    const artifacts = await Promise.all([
      this.#uploadArtifact(prefix, "state", local.statePath),
      this.#uploadArtifact(prefix, "memory", local.memoryPath),
      this.#uploadArtifact(prefix, "rootfs", local.rootfsPath),
      this.#uploadArtifact(prefix, "kernel", local.kernelPath),
    ]);
    const unsigned = {
      version: 1 as const,
      snapshotId: local.id,
      kind: "base" as const,
      createdAt: local.createdAt,
      keyId: key.keyId,
      artifacts,
      rootfsRestorePath: local.rootfsPath,
    };
    const signature = sign(unsigned, key.bytes);
    const body = Buffer.from(JSON.stringify({ ...unsigned, signature } satisfies SnapshotManifest));
    const manifestKey = `${prefix}/manifest.json`;
    const manifest = await this.#put(manifestKey, body);
    return {
      id: local.id,
      kind: "base",
      manifest,
      manifestKeyId: key.keyId,
      createdAt: local.createdAt,
    };
  }

  async resolve(ref: SnapshotRef): Promise<ResolvedSnapshot> {
    if (ref.kind !== "base")
      throw new CaissonError("SANDBOX_FAILED", "session snapshot restore is not implemented");
    const manifest = await this.#readManifest(ref);
    const destination = join(this.#cacheDirectory, "snapshots", ref.id);
    this.#inUse.add(ref.id);
    try {
      await this.#materialize(destination, manifest);
      await this.#materializeRootfs(manifest);
      this.#pinned.add(ref.id);
      this.#rootfsBySnapshot.set(ref.id, manifest.rootfsRestorePath);
      await this.#evict();
      const artifact = (name: ManifestArtifact["name"]) => join(destination, name);
      return {
        ref,
        statePath: artifact("state"),
        memoryPath: artifact("memory"),
        rootfsPath: manifest.rootfsRestorePath,
        kernelPath: artifact("kernel"),
      };
    } catch (error: unknown) {
      await rm(destination, { force: true, recursive: true });
      throw error;
    } finally {
      this.#inUse.delete(ref.id);
    }
  }

  async release(ref: SnapshotRef): Promise<void> {
    this.#pinned.delete(ref.id);
    this.#rootfsBySnapshot.delete(ref.id);
    await this.#evict();
  }

  /**
   * Copies an immutable rootfs into the cache before Firecracker starts. The
   * resulting absolute path must be passed to FirecrackerDriver, because
   * Firecracker restores block backing files at their original path.
   */
  async stageBaseRootfs(sourcePath: string): Promise<string> {
    const source = await readFile(sourcePath);
    const hash = sha256(source);
    const destination = join(this.#cacheDirectory, "rootfs", hash, "rootfs");
    try {
      await stat(destination);
      await utimes(destination, new Date(), new Date());
      return destination;
    } catch {
      // Materialize below.
    }
    const temporary = `${destination}.tmp-${randomUUID()}`;
    await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
    try {
      await copyFile(sourcePath, temporary);
      const copied = await readFile(temporary);
      if (sha256(copied) !== hash || copied.byteLength !== source.byteLength) {
        throw new CaissonError("SANDBOX_FAILED", "staged rootfs integrity verification failed");
      }
      await rename(temporary, destination);
      return destination;
    } catch (error: unknown) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async #uploadArtifact(
    prefix: string,
    name: ManifestArtifact["name"],
    path: string,
  ): Promise<ManifestArtifact> {
    const source = await readFile(path);
    const compressed = await gzipAsync(source);
    return {
      name,
      object: await this.#put(`${prefix}/${name}.gz`, compressed),
      uncompressedSha256: sha256(source),
      uncompressedSizeBytes: source.byteLength,
      compression: "gzip",
    };
  }

  async #put(key: string, body: Buffer): Promise<SnapshotObjectRef> {
    const output = await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ServerSideEncryption: "AES256",
      }),
    );
    const head = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
    if (head.ServerSideEncryption !== "AES256") {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "snapshot object server-side encryption was not confirmed",
      );
    }
    return {
      bucket: this.#bucket,
      key,
      ...(output.VersionId === undefined ? {} : { versionId: output.VersionId }),
      sha256: sha256(body),
      sizeBytes: body.byteLength,
    };
  }

  async #readManifest(ref: SnapshotRef): Promise<SnapshotManifest> {
    const bytes = await this.#download(ref.manifest);
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new CaissonError("SANDBOX_FAILED", "snapshot manifest is invalid");
    }
    const parsed = snapshotManifestSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new CaissonError("SANDBOX_FAILED", "snapshot manifest is invalid");
    }
    const manifest = parsed.data;
    const key = await this.#manifestKeys.resolve(manifest.keyId);
    const { signature, ...unsigned } = manifest;
    const expected = Buffer.from(sign(unsigned, key.bytes), "hex");
    const actual = Buffer.from(signature, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new CaissonError("SANDBOX_FAILED", "snapshot manifest authentication failed");
    }
    return manifest;
  }

  async #materialize(destination: string, manifest: SnapshotManifest): Promise<void> {
    try {
      await stat(join(destination, ".complete"));
      await utimes(destination, new Date(), new Date());
      return;
    } catch {
      // A complete marker is written only after all artifact checks succeed.
    }
    const temporary = `${destination}.tmp-${randomUUID()}`;
    await rm(temporary, { force: true, recursive: true });
    await mkdir(temporary, { recursive: true });
    try {
      for (const artifact of manifest.artifacts) {
        if (artifact.name === "rootfs") continue;
        const compressed = await this.#download(toSnapshotObjectRef(artifact.object));
        const body = await gunzipAsync(compressed);
        if (
          body.byteLength !== artifact.uncompressedSizeBytes ||
          sha256(body) !== artifact.uncompressedSha256
        ) {
          throw new CaissonError(
            "SANDBOX_FAILED",
            "snapshot artifact integrity verification failed",
          );
        }
        await writeFile(join(temporary, artifact.name), body, { flag: "wx" });
      }
      await writeFile(join(temporary, ".complete"), "verified\n", { flag: "wx" });
      await mkdir(dirname(destination), { recursive: true });
      // Never replace a verified cache entry. A concurrent resolver can use it.
      try {
        await stat(destination);
        await rm(temporary, { force: true, recursive: true });
        return;
      } catch {
        // Destination does not exist.
      }
      await rename(temporary, destination);
    } catch (error: unknown) {
      await rm(temporary, { force: true, recursive: true });
      throw error;
    }
  }

  async #materializeRootfs(manifest: SnapshotManifest): Promise<void> {
    const rootfs = manifest.artifacts.find((artifact) => artifact.name === "rootfs");
    if (
      rootfs === undefined ||
      !isPathInside(manifest.rootfsRestorePath, join(this.#cacheDirectory, "rootfs"))
    ) {
      throw new CaissonError("SANDBOX_FAILED", "snapshot rootfs restore path is invalid");
    }
    try {
      const existing = await readFile(manifest.rootfsRestorePath);
      if (
        existing.byteLength === rootfs.uncompressedSizeBytes &&
        sha256(existing) === rootfs.uncompressedSha256
      ) {
        await utimes(manifest.rootfsRestorePath, new Date(), new Date());
        return;
      }
    } catch {
      // Materialize a verified rootfs below.
    }
    const temporary = `${manifest.rootfsRestorePath}.tmp-${randomUUID()}`;
    await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
    try {
      const compressed = await this.#download(toSnapshotObjectRef(rootfs.object));
      const body = await gunzipAsync(compressed);
      if (
        body.byteLength !== rootfs.uncompressedSizeBytes ||
        sha256(body) !== rootfs.uncompressedSha256
      ) {
        throw new CaissonError("SANDBOX_FAILED", "snapshot rootfs integrity verification failed");
      }
      await writeFile(temporary, body, { flag: "wx" });
      try {
        await stat(manifest.rootfsRestorePath);
        await rm(temporary, { force: true });
      } catch {
        await rename(temporary, manifest.rootfsRestorePath);
      }
    } catch (error: unknown) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async #download(object: SnapshotObjectRef): Promise<Buffer> {
    const output = await this.#client.send(
      new GetObjectCommand({
        Bucket: object.bucket,
        Key: object.key,
        ...(object.versionId === undefined ? {} : { VersionId: object.versionId }),
      }),
    );
    const body = output.Body;
    if (body === undefined) throw new CaissonError("SANDBOX_FAILED", "snapshot object is empty");
    const bytes = Buffer.from(await body.transformToByteArray());
    if (bytes.byteLength !== object.sizeBytes || sha256(bytes) !== object.sha256) {
      throw new CaissonError("SANDBOX_FAILED", "snapshot object integrity verification failed");
    }
    return bytes;
  }

  async #evict(): Promise<void> {
    const snapshotDirectory = join(this.#cacheDirectory, "snapshots");
    const rootfsDirectory = join(this.#cacheDirectory, "rootfs");
    const [snapshotItems, rootfsItems] = await Promise.all([
      readdir(snapshotDirectory, { withFileTypes: true }).catch(() => []),
      readdir(rootfsDirectory, { withFileTypes: true }).catch(() => []),
    ]);
    const entries = await Promise.all([
      ...snapshotItems
        .filter((item) => item.isDirectory())
        .map(async (item) => ({
          id: item.name,
          kind: "snapshot" as const,
          path: join(snapshotDirectory, item.name),
          stat: await stat(join(snapshotDirectory, item.name)),
        })),
      ...rootfsItems
        .filter((item) => item.isDirectory())
        .map(async (item) => ({
          id: item.name,
          kind: "rootfs" as const,
          path: join(rootfsDirectory, item.name),
          stat: await stat(join(rootfsDirectory, item.name)),
        })),
    ]);
    let used = (await Promise.all(entries.map((entry) => directoryBytes(entry.path)))).reduce(
      (total, size) => total + size,
      0,
    );
    for (const entry of entries.sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs)) {
      if (used <= this.#cacheMaxBytes) return;
      const rootfsInUse = [...this.#rootfsBySnapshot.values()].some((path) =>
        path.startsWith(`${entry.path}${process.platform === "win32" ? "\\" : "/"}`),
      );
      if (
        (entry.kind === "snapshot" && (this.#pinned.has(entry.id) || this.#inUse.has(entry.id))) ||
        (entry.kind === "rootfs" && rootfsInUse)
      ) {
        continue;
      }
      const size = await directoryBytes(entry.path);
      await rm(entry.path, { recursive: true, force: true });
      used -= size;
    }
  }
}

function sign(value: object, key: Buffer): string {
  return createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function toSnapshotObjectRef(value: z.infer<typeof snapshotObjectRefSchema>): SnapshotObjectRef {
  return {
    bucket: value.bucket,
    key: value.key,
    ...(value.versionId === undefined ? {} : { versionId: value.versionId }),
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
  };
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) =>
      entry.isDirectory()
        ? directoryBytes(join(path, entry.name))
        : (await stat(join(path, entry.name))).size,
    ),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

function isPathInside(path: string, parent: string): boolean {
  const child = relative(resolve(parent), resolve(path));
  return (
    child !== "" &&
    !child.startsWith("..") &&
    !child.includes(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
}
