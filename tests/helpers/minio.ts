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
    async close() {
      await container.stop();
    },
  };
}
