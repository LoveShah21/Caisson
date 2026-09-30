import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const canBuildRootfs =
  process.platform === "linux" && ["go", "mkfs.ext4", "debugfs"].every(commandAvailable);

describe("M-2 runtime rootfs inventory", () => {
  it.skipIf(!canBuildRootfs)(
    "builds the eligible runtime rootfs and rejects inventory additions outside /init, /dev, and /proc",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "caisson-runtime-rootfs-"));
      const rootfs = join(directory, "caisson-runtime-rootfs.ext4");
      try {
        const output = execFileSync("bash", ["guest/rootfs/build-runtime-rootfs.sh", rootfs], {
          encoding: "utf8",
        });
        expect(output).toContain("PASS runtime rootfs inventory");
        const extra = join(directory, "unexpected");
        await writeFile(extra, "not part of the runtime");
        execFileSync("debugfs", ["-w", "-R", `write ${extra} /unexpected`, rootfs]);
        expect(() =>
          execFileSync("node", ["scripts/check-runtime-rootfs-inventory.mjs", rootfs], {
            encoding: "utf8",
          }),
        ).toThrow(/unexpected paths/u);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

function commandAvailable(command: string): boolean {
  // The rootfs builder checks command availability rather than whether every
  // tool accepts a common --version flag. debugfs and mkfs.ext4 differ there.
  return spawnSync("bash", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}
