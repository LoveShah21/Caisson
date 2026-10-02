import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const rootfs = process.argv[2];
const printOnly = process.argv[3] === "--print";
const writeLock = process.argv[3] === "--write-lock";
const printRuntimeArtifacts = process.argv[3] === "--print-runtime-artifacts";
if (rootfs === undefined)
  throw new Error("usage: check-agent-runtime-rootfs-inventory.mjs <rootfs> [--print]");
if (basename(rootfs) !== "caisson-agent-runtime-rootfs.ext4")
  throw new Error("inventory only accepts the production M-3 agent runtime rootfs");

function entries(directory) {
  const listing = execFileSync("debugfs", ["-R", `ls -p ${directory}`, rootfs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return listing
    .split(/\r?\n/u)
    .map((line) => line.split("/"))
    .filter((fields) => fields[0] === "" && /^\d+$/u.test(fields[1] ?? ""))
    .map((fields) => ({ mode: fields[2] ?? "", name: fields[5] ?? "" }))
    .filter((entry) => entry.name !== "" && entry.name !== "." && entry.name !== "..");
}

function inventory(directory = "/", prefix = "") {
  const output = [];
  for (const entry of entries(directory)) {
    const path = `${prefix}/${entry.name}`;
    output.push({ mode: entry.mode, path });
    if (entry.mode.startsWith("04")) output.push(...inventory(path, path));
  }
  return output;
}

const actual = inventory().sort((left, right) => left.path.localeCompare(right.path));
const rendered = actual.map((entry) => `${entry.mode}\t${entry.path}`).join("\n");
if (printOnly) {
  process.stdout.write(`${rendered}\n`);
  process.exit(0);
}

const runtimeArtifactsPath = resolve("guest/rootfs/agent-runtime-runtime-artifacts.lock");
const expectedRuntimeArtifacts = (await readFile(runtimeArtifactsPath, "utf8"))
  .split(/\r?\n/u)
  .map((value) => value.trim())
  .filter((value) => value !== "" && !value.startsWith("#"));
if (
  expectedRuntimeArtifacts.length !== 1 ||
  expectedRuntimeArtifacts[0] !== "/run/caisson/agent.sock"
) {
  throw new Error("agent runtime artifact allowlist must contain only /run/caisson/agent.sock");
}
if (printRuntimeArtifacts) {
  process.stdout.write(`${expectedRuntimeArtifacts.join("\n")}\n`);
  process.exit(0);
}

const lockPath = resolve("guest/rootfs/agent-runtime-rootfs-files.lock");
if (writeLock) {
  await writeFile(lockPath, `${rendered}\n`, "utf8");
  process.stdout.write("WROTE agent runtime rootfs inventory allowlist\n");
  process.exit(0);
}
const expectedRendered = (await readFile(lockPath, "utf8")).trim();
if (rendered !== expectedRendered) {
  throw new Error(
    "agent runtime rootfs inventory differs from the checked-in allowlist; regenerate only after reviewing every file and dependency",
  );
}
process.stdout.write("PASS agent runtime rootfs inventory and runtime artifact allowlist\n");
