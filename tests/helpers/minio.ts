import { readFileSync } from "node:fs";

import { GenericContainer, Wait } from "testcontainers";

const imageConfiguration = readFileSync(
  new URL("../../deploy/minio/image.env", import.meta.url),
  "utf8",
);
const minioImage = imageConfiguration
  .split(/\r?\n/u)
  .find((line) => line.startsWith("CAISSON_MINIO_IMAGE="))
  ?.slice("CAISSON_MINIO_IMAGE=".length);

if (minioImage === undefined || minioImage.length === 0) {
  throw new Error("deploy/minio/image.env must define CAISSON_MINIO_IMAGE");
}

export interface MinioFixture {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  createPrefixRestrictedUser(input: {
    readonly bucket: string;
    readonly prefix: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  }): Promise<void>;
  close(): Promise<void>;
}

export async function createMinioFixture(): Promise<MinioFixture> {
  const accessKeyId = "caisson";
  const secretAccessKey = "caisson-minio-test-only";
  const staticKey = Buffer.alloc(32, 7).toString("base64");
  const container = await new GenericContainer(minioImage)
    .withEnvironment({
      MINIO_ROOT_USER: accessKeyId,
      MINIO_ROOT_PASSWORD: secretAccessKey,
      MINIO_KMS_SECRET_KEY: `snapshot-test-key:${staticKey}`,
    })
    .withCommand(["server", "/data"])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000))
    .start();
  return {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    accessKeyId,
    secretAccessKey,
    async createPrefixRestrictedUser(input) {
      const policyName = `caisson-prefix-${input.accessKeyId}`;
      const policyPath = `/tmp/${policyName}.json`;
      await container.copyContentToContainer([
        {
          content: JSON.stringify(createPrefixPolicy(input.bucket, input.prefix)),
          target: policyPath,
          // Testcontainers writes this as root. mc runs as the non-root
          // MinIO service user, so it needs read access to this non-secret
          // policy document.
          mode: 0o644,
        },
      ]);
      await runMc(container, [
        "alias",
        "set",
        "caisson",
        "http://127.0.0.1:9000",
        accessKeyId,
        secretAccessKey,
        "--api",
        "S3v4",
      ]);
      await runMc(container, ["admin", "policy", "create", "caisson", policyName, policyPath]);
      await runMc(container, [
        "admin",
        "user",
        "add",
        "caisson",
        input.accessKeyId,
        input.secretAccessKey,
      ]);
      await runMc(container, [
        "admin",
        "policy",
        "attach",
        "caisson",
        policyName,
        "--user",
        input.accessKeyId,
      ]);
    },
    async close() {
      await container.stop();
    },
  };
}

async function runMc(
  container: Awaited<ReturnType<GenericContainer["start"]>>,
  command: readonly string[],
): Promise<void> {
  const result = await container.exec(["mc", ...command], {
    env: { MC_CONFIG_DIR: "/tmp/caisson-mc" },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `MinIO test IAM setup failed while running mc ${command.slice(0, 3).join(" ")}`,
    );
  }
}

function createPrefixPolicy(bucket: string, prefix: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetBucketLocation"],
        Resource: [`arn:aws:s3:::${bucket}`],
      },
      {
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [`arn:aws:s3:::${bucket}`],
        Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`arn:aws:s3:::${bucket}/${prefix}*`],
      },
    ],
  };
}
