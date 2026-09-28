import { GenericContainer, Wait } from "testcontainers";

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
  const container = await new GenericContainer("minio/minio:RELEASE.2025-09-07T16-13-09Z")
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
