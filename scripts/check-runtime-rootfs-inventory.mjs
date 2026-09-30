import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const rootfs = process.argv[2];
if (rootfs === undefined) throw new Error("usage: check-runtime-rootfs-inventory.mjs <rootfs>");
if (basename(rootfs) !== "caisson-runtime-rootfs.ext4")
  throw new Error("inventory only accepts the production runtime rootfs");
function entries(directory) {
  const listing = execFileSync("debugfs", ["-R", `ls -p ${directory}`, rootfs], {
    encoding: "utf8",
  });
  return listing
    .split(/\r?\n/u)
    .map((line) => line.split("/"))
    .filter((fields) => fields[0] === "" && /^\d+$/u.test(fields[1] ?? ""))
    .map((fields) => ({ mode: fields[2], path: fields[5] }))
    .filter((entry) => entry.path !== undefined && entry.path !== "");
}

const rootEntries = entries("/");
const paths = rootEntries.map((entry) => entry.path);
const allowed = new Set([".", "..", "init", "dev", "proc", "lost+found"]);
const unexpected = paths.filter((path) => !allowed.has(path));
if (unexpected.length > 0)
  throw new Error(`runtime rootfs contains unexpected paths: ${unexpected.join(", ")}`);
if (!paths.includes("init") || !paths.includes("dev") || !paths.includes("proc"))
  throw new Error("runtime rootfs inventory is incomplete");
if (rootEntries.find((entry) => entry.path === "init")?.mode !== "100755")
  throw new Error("runtime rootfs init must be mode 100755");
const deviceEntries = entries("/dev");
const devicePaths = deviceEntries.map((entry) => entry.path);
const allowedDevices = new Set([".", "..", "null", "random", "urandom"]);
const unexpectedDevices = devicePaths.filter((path) => !allowedDevices.has(path));
if (unexpectedDevices.length > 0)
  throw new Error(`runtime rootfs contains unexpected devices: ${unexpectedDevices.join(", ")}`);
for (const requiredDevice of ["null", "random", "urandom"])
  if (!devicePaths.includes(requiredDevice))
    throw new Error(`runtime rootfs is missing required device: ${requiredDevice}`);
for (const requiredDevice of ["null", "random", "urandom"])
  if (deviceEntries.find((entry) => entry.path === requiredDevice)?.mode !== "020666")
    throw new Error(`runtime rootfs device ${requiredDevice} must be mode 020666`);
process.stdout.write("PASS runtime rootfs inventory\n");
