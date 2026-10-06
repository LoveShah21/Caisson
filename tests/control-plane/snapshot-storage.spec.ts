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
import { SessionSnapshotCrypto } from "../../apps/control-plane/src/session-snapshot-crypto.js";
import { S3SessionSnapshotStore } from "../../apps/control-plane/src/session-snapshot-storage.js";
import type {
  LocalSnapshot,
  SnapshotObjectRef,
  SnapshotRef,
} from "../../packages/isolation/src/index.js";
import { SecretString } from "../../packages/secrets/src/credentials.js";
import type { SecretBackend } from "../../packages/secrets/src/types.js";
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
  await minio?.close();
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

describe("S3SessionSnapshotStore", () => {
  it("encrypts each session artifact, confirms SSE, and restores only its originating lineage", async () => {
    const crypto = sessionCrypto();
    const store = createSessionStore(crypto);
    const sessionKek = await crypto.createWrappedSessionKek();
    const snapshotDek = await crypto.createWrappedSnapshotDek(sessionKek);
    const siblingDek = await crypto.createWrappedSnapshotDek(sessionKek);
    const sessionId = "018f0000-0000-7000-8000-000000000b01";
    const baseSnapshotId = "018f0000-0000-7000-8000-000000000b02";
    const source = join(root, "session-source");
    await writeFile(`${source}.state`, "session-state");
    await writeFile(`${source}.memory`, "session-memory");
    const ref = await store.store(
      {
        id: "018f0000-0000-7000-8000-000000000b03",
        kind: "session",
        statePath: `${source}.state`,
        memoryPath: `${source}.memory`,
        createdAt: "2026-10-06T00:00:00.000Z",
      },
      { sessionId, baseSnapshotId, sessionKek, snapshotDek },
    );
    const manifest = (await manifestFor(ref)) as TestSessionManifest;
    for (const artifact of manifest.artifacts) {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: artifact.object.bucket, Key: artifact.object.key }),
      );
      expect(head.ServerSideEncryption).toBe("AES256");
      expect(
        (await objectBytes(artifact.object.bucket, artifact.object.key)).includes(
          Buffer.from(`session-${artifact.name}`),
        ),
      ).toBe(false);
    }

    const resolved = await store.resolve(ref, {
      sessionId,
      sessionKek,
      snapshotDek,
      base: baseResolution(baseSnapshotId),
    });
    expect(await readFile(resolved.statePath, "utf8")).toBe("session-state");
    expect(await readFile(resolved.memoryPath, "utf8")).toBe("session-memory");
    await expect(
      store.resolve(ref, {
        sessionId: "018f0000-0000-7000-8000-000000000bff",
        sessionKek,
        snapshotDek,
        base: baseResolution(baseSnapshotId),
      }),
    ).rejects.toThrow("lineage is invalid");
    await expect(
      store.resolve(ref, {
        sessionId,
        sessionKek,
        snapshotDek: siblingDek,
        base: baseResolution(baseSnapshotId),
      }),
    ).rejects.toThrow();
  }, 60_000);

  it("rejects a modified encrypted artifact without leaving a partial session cache entry", async () => {
    const crypto = sessionCrypto();
    const store = createSessionStore(crypto);
    const sessionKek = await crypto.createWrappedSessionKek();
    const snapshotDek = await crypto.createWrappedSnapshotDek(sessionKek);
    const sessionId = "018f0000-0000-7000-8000-000000000c01";
    const baseSnapshotId = "018f0000-0000-7000-8000-000000000c02";
    const source = join(root, "tampered-session-source");
    await writeFile(`${source}.state`, "state");
    await writeFile(`${source}.memory`, "memory");
    const ref = await store.store(
      {
        id: "018f0000-0000-7000-8000-000000000c03",
        kind: "session",
        statePath: `${source}.state`,
        memoryPath: `${source}.memory`,
        createdAt: "2026-10-06T00:00:00.000Z",
      },
      { sessionId, baseSnapshotId, sessionKek, snapshotDek },
    );
    const manifest = (await manifestFor(ref)) as TestSessionManifest;
    const state = manifest.artifacts.find((artifact) => artifact.name === "state");
    if (state === undefined) throw new Error("session state artifact is missing");
    await client.send(
      new PutObjectCommand({
        Bucket: state.object.bucket,
        Key: state.object.key,
        Body: Buffer.from("tampered"),
        ServerSideEncryption: "AES256",
      }),
    );
    await expect(
      store.resolve(ref, {
        sessionId,
        sessionKek,
        snapshotDek,
        base: baseResolution(baseSnapshotId),
      }),
    ).rejects.toThrow("integrity");
    const entries = await readdir(join(root, "cache", "session-snapshots")).catch(() => []);
    expect(entries.some((entry) => entry === ref.id || entry.startsWith(`${ref.id}.tmp-`))).toBe(
      false,
    );
  }, 60_000);
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

interface TestSessionManifest {
  readonly artifacts: readonly {
    readonly name: "state" | "memory";
    readonly object: SnapshotObjectRef;
  }[];
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

function sessionCrypto(): SessionSnapshotCrypto {
  return new SessionSnapshotCrypto(new TestSnapshotKeyBackend(), {
    backend: "env",
    backendPath: "TEST_SESSION_SNAPSHOT_KEK",
    role: "snapshot-kek",
  });
}

function createSessionStore(crypto: SessionSnapshotCrypto): S3SessionSnapshotStore {
  return new S3SessionSnapshotStore({
    endpoint: minio.endpoint,
    region: "us-east-1",
    accessKeyId: minio.accessKeyId,
    secretAccessKey: minio.secretAccessKey,
    bucket: `session-snapshots-${Math.random().toString(16).slice(2)}`,
    cacheDirectory: join(root, "cache"),
    cacheMaxBytes: 1024 * 1024,
    manifestKeys: new EnvManifestKeyProvider(keyId, key),
    crypto,
  });
}

function baseResolution(id: string) {
  return {
    ref: {
      id,
      kind: "base" as const,
      manifest: {
        bucket: "base",
        key: "manifest.json",
        sha256: "c".repeat(64),
        sizeBytes: 1,
      },
      manifestKeyId: "manifest-key",
      createdAt: "2026-10-06T00:00:00.000Z",
    },
    statePath: "base-state",
    memoryPath: "base-memory",
    rootfsPath: "base-rootfs",
    kernelPath: "base-kernel",
  };
}

class TestSnapshotKeyBackend implements SecretBackend {
  async fetch() {
    return {
      kind: "snapshot_kek" as const,
      keyId: "test-session-root-kek",
      key: new SecretString(Buffer.alloc(32, 9).toString("base64")),
    };
  }
  async health(): Promise<boolean> {
    return true;
  }
}
