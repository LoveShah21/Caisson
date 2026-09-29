import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { S3Adapter } from "../../apps/broker/src/s3-adapter.js";
import { SecretString } from "../../packages/secrets/src/credentials.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMinioFixture, type MinioFixture } from "../helpers/minio.js";

const bucket = "adapter-test";
const context = { timeoutMs: 5_000 };
let fixture: MinioFixture;
let root: S3Client;
let restricted: S3Client;
const restrictedAccessKeyId = "caisson-s3-prefix-test";
const restrictedSecretAccessKey = "caisson-s3-prefix-test-secret";

beforeAll(async () => {
  fixture = await createMinioFixture();
  root = new S3Client({
    endpoint: fixture.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: fixture.accessKeyId, secretAccessKey: fixture.secretAccessKey },
  });
  await root.send(new CreateBucketCommand({ Bucket: bucket }));
  await root.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "allowed/text.json",
      Body: '{"ok":true}',
      ContentType: "application/json",
    }),
  );
  await root.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "allowed/data.bin",
      Body: Buffer.from([0, 255]),
      ContentType: "application/octet-stream",
    }),
  );
  await root.send(
    new PutObjectCommand({ Bucket: bucket, Key: "private/secret.txt", Body: "not allowlisted" }),
  );
  await fixture.createPrefixRestrictedUser({
    bucket,
    prefix: "allowed/",
    accessKeyId: restrictedAccessKeyId,
    secretAccessKey: restrictedSecretAccessKey,
  });
  restricted = new S3Client({
    endpoint: fixture.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: restrictedAccessKeyId,
      secretAccessKey: restrictedSecretAccessKey,
    },
  });
}, 60_000);

afterAll(async () => {
  root?.destroy();
  restricted?.destroy();
  await fixture?.close();
});

describe("S3Adapter", () => {
  it("declares the approved scopes", () => {
    const adapter = createAdapter();
    expect(adapter.methods.getObject.scopeRequired).toBe("s3.read");
    expect(adapter.methods.listObjects.scopeRequired).toBe("s3.read");
    expect(adapter.methods.putObject.scopeRequired).toBe("s3.write");
    expect(adapter.methods.deleteObject.scopeRequired).toBe("s3.delete");
    adapter.destroy();
  });

  it("gets text and binary objects using explicit encodings", async () => {
    const adapter = createAdapter();
    try {
      await expect(
        adapter.methods.getObject.execute(
          credentials(),
          { bucket, key: "allowed/text.json" },
          context,
        ),
      ).resolves.toEqual({
        encoding: "utf8",
        data: '{"ok":true}',
        contentType: "application/json",
        size: 11,
      });
      await expect(
        adapter.methods.getObject.execute(
          credentials(),
          { bucket, key: "allowed/data.bin" },
          context,
        ),
      ).resolves.toEqual({
        encoding: "base64",
        data: "AP8=",
        contentType: "application/octet-stream",
        size: 2,
      });
    } finally {
      adapter.destroy();
    }
  });

  it("puts, lists, and deletes only allowlisted objects", async () => {
    const adapter = createAdapter();
    try {
      await adapter.methods.putObject.execute(
        credentials(),
        {
          bucket,
          key: "allowed/upload.bin",
          body: { encoding: "base64", data: "AP8=" },
          contentType: "application/octet-stream",
        },
        context,
      );
      await expect(
        adapter.methods.listObjects.execute(credentials(), { bucket, prefix: "allowed/" }, context),
      ).resolves.toEqual({
        keys: expect.arrayContaining([
          "allowed/data.bin",
          "allowed/text.json",
          "allowed/upload.bin",
        ]),
      });
      await adapter.methods.deleteObject.execute(
        credentials(),
        { bucket, key: "allowed/upload.bin" },
        context,
      );
    } finally {
      adapter.destroy();
    }
  });

  it("rejects prefix escapes before its credential can reach MinIO", async () => {
    const adapter = createAdapter();
    try {
      await expect(
        adapter.methods.getObject.execute(
          credentials(),
          { bucket, key: "private/secret.txt" },
          context,
        ),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
      await expect(
        adapter.methods.getObject.execute(
          credentials(),
          { bucket, key: "/allowed/text.json" },
          context,
        ),
      ).rejects.toMatchObject({ code: "PARAMS_INVALID" });
      await expect(
        adapter.methods.getObject.execute(
          credentials(),
          { bucket, key: "allowed/../private/secret.txt" },
          context,
        ),
      ).rejects.toMatchObject({ code: "PARAMS_INVALID" });
      await expect(
        adapter.methods.getObject.execute(
          credentials(),
          { bucket, key: "allowed/%2e%2e/private/secret.txt" },
          context,
        ),
      ).rejects.toMatchObject({ code: "PARAMS_INVALID" });
      await expect(
        adapter.methods.listObjects.execute(credentials(), { bucket, prefix: "private/" }, context),
      ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    } finally {
      adapter.destroy();
    }
  });

  it("is blocked by MinIO IAM outside the configured prefix", async () => {
    await expect(
      restricted.send(new GetObjectCommand({ Bucket: bucket, Key: "allowed/text.json" })),
    ).resolves.toBeDefined();
    await expect(
      restricted.send(new GetObjectCommand({ Bucket: bucket, Key: "private/secret.txt" })),
    ).rejects.toMatchObject({ name: "AccessDenied" });
  });

  it("enforces the raw object size limit", async () => {
    const adapter = createAdapter({ objectSizeBytes: 1 });
    try {
      await expect(
        adapter.methods.getObject.execute(
          credentials(),
          { bucket, key: "allowed/data.bin" },
          context,
        ),
      ).rejects.toMatchObject({ code: "SERVICE_ERROR" });
    } finally {
      adapter.destroy();
    }
  });
});

function createAdapter(overrides: Partial<{ readonly objectSizeBytes: number }> = {}): S3Adapter {
  return new S3Adapter({
    endpoint: fixture.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    allowlist: [{ bucket, prefix: "allowed/" }],
    timeoutMs: 1_000,
    objectSizeBytes: 1024,
    listLimit: 100,
    ...overrides,
  });
}

function credentials() {
  return {
    kind: "s3" as const,
    accessKeyId: new SecretString(restrictedAccessKeyId),
    secretAccessKey: new SecretString(restrictedSecretAccessKey),
  };
}
