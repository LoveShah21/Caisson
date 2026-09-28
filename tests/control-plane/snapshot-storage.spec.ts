import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  EnvManifestKeyProvider,
  S3BaseSnapshotStore,
} from "../../apps/control-plane/src/snapshot-storage.js";
import type {
  LocalSnapshot,
  SnapshotObjectRef,
  SnapshotRef,
} from "../../packages/isolation/src/index.js";
import { createMinioFixture, type MinioFixture } from "../helpers/minio.js";

const keyId = "test-manifest-key";
const key = Buffer.alloc(32, 3).toString("base64");
let minio: MinioFixture;
let root: string;
let client: S3Client;

beforeAll(async () => {
  minio = await createMinioFixture();
  root = await mkdtemp(join(tmpdir(), "caisson-snapshot-storage-"));
  client = new S3Client({
    endpoint: minio.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: minio.accessKeyId, secretAccessKey: minio.secretAccessKey },
  });
}, 60_000);

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
  root = await mkdtemp(join(tmpdir(), "caisson-snapshot-storage-"));
});

afterAll(async () => {
  await minio.close();
});

describe("S3BaseSnapshotStore", () => {
  it("uploads a signed, SSE-protected base manifest and resolves a verified cache hit", async () => {
    const store = createStore();
    const snapshot = await storeBase(store, "first");

    const manifestHead = await client.send(
      new HeadObjectCommand({ Bucket: snapshot.manifest.bucket, Key: snapshot.manifest.key }),
    );
    expect(manifestHead.ServerSideEncryption).toBe("AES256");

    const resolved = await store.resolve(snapshot);
    expect(await readFile(resolved.statePath, "utf8")).toBe("state-first");
    expect(await readFile(resolved.memoryPath, "utf8")).toBe("memory-first");
    expect(resolved.rootfsPath).toContain(join("rootfs", ""));

    const before = (await stat(resolved.statePath)).mtimeMs;
    const cached = await store.resolve(snapshot);
    expect(cached.statePath).toBe(resolved.statePath);
    expect((await stat(cached.statePath)).mtimeMs).toBeGreaterThanOrEqual(before);
  }, 60_000);

  it("rejects a flipped or truncated artifact without leaving a partial cache entry", async () => {
    const store = createStore();
    const snapshot = await storeBase(store, "corrupt");
    const manifest = await manifestFor(snapshot);
    const state = manifest.artifacts.find(
      (artifact: { name: string }) => artifact.name === "state",
    );
    const memory = manifest.artifacts.find(
      (artifact: { name: string }) => artifact.name === "memory",
    );
    if (state === undefined || memory === undefined) throw new Error("test manifest is incomplete");

    await client.send(
      new PutObjectCommand({
        Bucket: snapshot.manifest.bucket,
        Key: state.object.key,
        Body: Buffer.from("flipped"),
      }),
    );
    await expect(store.resolve(snapshot)).rejects.toThrow("integrity");
    await expectNoPartialEntry(snapshot.id);

    await client.send(
      new PutObjectCommand({
        Bucket: snapshot.manifest.bucket,
        Key: memory.object.key,
        Body: Buffer.from("short"),
      }),
    );
    await expect(store.resolve(snapshot)).rejects.toThrow("integrity");
    await expectNoPartialEntry(snapshot.id);
  }, 60_000);

  it("rejects a manifest whose authenticated fields were changed", async () => {
    const store = createStore();
    const snapshot = await storeBase(store, "manifest-authentication");
    const raw = await objectBytes(snapshot.manifest.bucket, snapshot.manifest.key);
    const altered = Buffer.from(
      raw.toString("utf8").replace("manifest-authentication", "manifest-tampered"),
    );
    await client.send(
      new PutObjectCommand({
        Bucket: snapshot.manifest.bucket,
        Key: snapshot.manifest.key,
        Body: altered,
        ServerSideEncryption: "AES256",
      }),
    );
    await expect(
      store.resolve({
        ...snapshot,
        manifest: {
          ...snapshot.manifest,
          sha256: createHash("sha256").update(altered).digest("hex"),
          sizeBytes: altered.byteLength,
        },
      }),
    ).rejects.toThrow("authentication failed");
  }, 60_000);

  it("evicts least-recently-used released entries but never a pinned base snapshot", async () => {
    const store = createStore(90);
    const first = await storeBase(store, "lru-first");
    const second = await storeBase(store, "lru-second");

    await store.resolve(first);
    await store.resolve(second);
    expect(await stat(join(root, "cache", "snapshots", first.id))).toBeDefined();
    expect(await stat(join(root, "cache", "snapshots", second.id))).toBeDefined();

    await store.release(first);
    await store.release(second);
    await store.resolve(second);

    await expect(stat(join(root, "cache", "snapshots", second.id))).resolves.toBeDefined();
    await expect(stat(join(root, "cache", "snapshots", first.id))).rejects.toThrow();
  }, 60_000);

  it("rejects missing, short, and invalid cache configuration at startup", () => {
    expect(() => EnvManifestKeyProvider.fromEnvironment({})).toThrow("missing");
    expect(() => new EnvManifestKeyProvider(keyId, Buffer.alloc(31).toString("base64"))).toThrow(
      "invalid",
    );
    expect(() => S3BaseSnapshotStore.cacheMaxBytesFromEnvironment({})).toThrow("missing");
    expect(() =>
      S3BaseSnapshotStore.cacheMaxBytesFromEnvironment({ CAISSON_SNAPSHOT_CACHE_MAX_BYTES: "0" }),
    ).toThrow("invalid");
  });

  it("refuses the M-1 development probe rootfs before it can become a base artifact", async () => {
    const store = createStore();
    await expect(
      store.storeBase({
        id: "development-probe",
        kind: "base",
        statePath: "unused",
        memoryPath: "unused",
        rootfsPath: "m1-dev-probe-rootfs.ext4",
        kernelPath: "unused",
        createdAt: "2026-09-28T00:00:00.000Z",
      }),
    ).rejects.toThrow("ineligible");
  });
});

function createStore(cacheMaxBytes = 1024 * 1024): S3BaseSnapshotStore {
  return new S3BaseSnapshotStore({
    endpoint: minio.endpoint,
    region: "us-east-1",
    accessKeyId: minio.accessKeyId,
    secretAccessKey: minio.secretAccessKey,
    bucket: `snapshots-${Math.random().toString(16).slice(2)}`,
    cacheDirectory: join(root, "cache"),
    cacheMaxBytes,
    manifestKeys: new EnvManifestKeyProvider(keyId, key),
  });
}

async function storeBase(store: S3BaseSnapshotStore, id: string): Promise<SnapshotRef> {
  const source = join(root, `${id}-source`);
  await writeFile(`${source}.state`, `state-${id}`);
  await writeFile(`${source}.memory`, `memory-${id}`);
  await writeFile(`${source}.rootfs`, `rootfs-${id}`);
  await writeFile(`${source}.kernel`, `kernel-${id}`);
  const rootfsPath = await store.stageBaseRootfs(`${source}.rootfs`);
  const local: LocalSnapshot = {
    id,
    kind: "base",
    statePath: `${source}.state`,
    memoryPath: `${source}.memory`,
    rootfsPath,
    kernelPath: `${source}.kernel`,
    createdAt: "2026-09-28T00:00:00.000Z",
  };
  return store.storeBase(local);
}

interface TestManifestArtifact {
  readonly name: string;
  readonly object: SnapshotObjectRef;
}

interface TestManifest {
  readonly artifacts: readonly TestManifestArtifact[];
}

async function manifestFor(snapshot: SnapshotRef): Promise<TestManifest> {
  return JSON.parse(
    (await objectBytes(snapshot.manifest.bucket, snapshot.manifest.key)).toString("utf8"),
  ) as TestManifest;
}

async function objectBytes(bucket: string, key: string): Promise<Buffer> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (response.Body === undefined) throw new Error("test object body is missing");
  return Buffer.from(await response.Body.transformToByteArray());
}

async function expectNoPartialEntry(id: string): Promise<void> {
  const entries = await readdir(join(root, "cache", "snapshots")).catch(() => []);
  expect(entries.some((entry) => entry === id || entry.startsWith(`${id}.tmp-`))).toBe(false);
}
