import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const policyDirectory = `${repositoryRoot}policies/bootstrap`;
const opaImage =
  "openpolicyagent/opa@sha256:22770e039a71a885231059c93166cce0644db256cab751043d94bfd150f220d5";

const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--mount",
    `type=bind,source=${policyDirectory},target=/src,readonly`,
    opaImage,
    "test",
    "/src",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
