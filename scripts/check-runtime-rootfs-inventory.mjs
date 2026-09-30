import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const rootfs = process.argv[2];
if (rootfs === undefined) throw new Error("usage: check-runtime-rootfs-inventory.mjs <rootfs>");
if (basename(rootfs) !== "caisson-runtime-rootfs.ext4")
  throw new Error("inventory only accepts the production runtime rootfs");
const listing = execFileSync("debugfs", ["-R", "ls -p /", rootfs], { encoding: "utf8" });
const paths = [...listing.matchAll(/\/\d+\/[^/]+\/\d+\/\d+\/([^/]+)\//g)].map((match) => match[1]);
const allowed = new Set([".", "..", "init", "dev", "proc", "lost+found"]);
const unexpected = paths.filter((path) => !allowed.has(path));
if (unexpected.length > 0)
  throw new Error(`runtime rootfs contains unexpected paths: ${unexpected.join(", ")}`);
if (!paths.includes("init") || !paths.includes("dev") || !paths.includes("proc"))
  throw new Error("runtime rootfs inventory is incomplete");
process.stdout.write("PASS runtime rootfs inventory\n");
