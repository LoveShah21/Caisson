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
    .map((fields) => fields[5])
    .filter((path) => path !== undefined && path !== "");
}

const paths = entries("/");
const allowed = new Set([".", "..", "init", "dev", "proc", "lost+found"]);
const unexpected = paths.filter((path) => !allowed.has(path));
if (unexpected.length > 0)
  throw new Error(`runtime rootfs contains unexpected paths: ${unexpected.join(", ")}`);
if (!paths.includes("init") || !paths.includes("dev") || !paths.includes("proc"))
  throw new Error("runtime rootfs inventory is incomplete");
const devicePaths = entries("/dev");
const allowedDevices = new Set([".", "..", "null", "random", "urandom"]);
const unexpectedDevices = devicePaths.filter((path) => !allowedDevices.has(path));
if (unexpectedDevices.length > 0)
  throw new Error(`runtime rootfs contains unexpected devices: ${unexpectedDevices.join(", ")}`);
for (const requiredDevice of ["null", "random", "urandom"])
  if (!devicePaths.includes(requiredDevice))
    throw new Error(`runtime rootfs is missing required device: ${requiredDevice}`);
process.stdout.write("PASS runtime rootfs inventory\n");
