import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const imageConfig = await readImageConfig();

execFileSync(
  "docker",
  [
    "build",
    "--build-arg",
    `GO_VERSION=${imageConfig.CAISSON_MINIO_GO_VERSION}`,
    "--build-arg",
    `MINIO_COMMIT=${imageConfig.CAISSON_MINIO_SOURCE_COMMIT}`,
    "--tag",
    imageConfig.CAISSON_MINIO_IMAGE,
    "deploy/minio",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);

async function readImageConfig() {
  const configuration = await readFile(
    new URL("../deploy/minio/image.env", import.meta.url),
    "utf8",
  );
  const values = Object.fromEntries(
    configuration
      .split(/\r?\n/u)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const [key, ...rest] = line.split("=");
        return [key, rest.join("=")];
      }),
  );
  for (const key of [
    "CAISSON_MINIO_IMAGE",
    "CAISSON_MINIO_SOURCE_COMMIT",
    "CAISSON_MINIO_GO_VERSION",
  ]) {
    if (typeof values[key] !== "string" || values[key].length === 0) {
      throw new Error(`deploy/minio/image.env is missing ${key}`);
    }
  }
  return values;
}
