import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";

export const opaImage =
  "openpolicyagent/opa@sha256:22770e039a71a885231059c93166cce0644db256cab751043d94bfd150f220d5";

export async function runPolicyTests(policyDirectory) {
  const files = await readdir(policyDirectory);
  const sources = files.filter((file) => file.endsWith(".rego") && !file.endsWith("_test.rego"));
  if (
    sources.length === 0 ||
    sources.some((file) => !files.includes(file.replace(/\.rego$/u, "_test.rego")))
  ) {
    throw new Error("every policy source must have a matching Rego test file");
  }
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
    { encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0 || !/PASS: [1-9][0-9]*\/[1-9][0-9]*/u.test(result.stdout ?? "")) {
    throw new Error(
      `OPA policy tests failed: ${result.stderr || result.stdout || result.error?.message || "unknown Docker failure"}`,
    );
  }
  return result.stdout;
}
