import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const enabled =
  process.env.CAISSON_AGENT_RUNTIME_ROOTFS_TESTS === "1" &&
  process.platform === "linux" &&
  ["curl", "debugfs", "go", "gpg", "mkfs.ext4"].every(commandAvailable);

describe("M-3 agent runtime rootfs inventory", () => {
  it.skipIf(!enabled)(
    "builds only the locked Alpine package closure and rejects an unexpected file",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "caisson-agent-runtime-rootfs-"));
      const rootfs = join(directory, "caisson-agent-runtime-rootfs.ext4");
      try {
        const output = execFileSync("bash", ["guest/rootfs/build-agent-runtime-rootfs.sh", rootfs], {
          encoding: "utf8",
          env: process.env,
        });
        expect(output).toContain("PASS agent runtime rootfs");
        expect(output).toContain("PASS agent runtime rootfs inventory and runtime artifact allowlist");
        expect(
          execFileSync("node", ["scripts/check-agent-runtime-rootfs-inventory.mjs", rootfs, "--print-runtime-artifacts"], {
            encoding: "utf8",
          }),
        ).toBe("/run/caisson/agent.sock\n");
        const unexpected = join(directory, "unexpected");
        await writeFile(unexpected, "must not be in the agent rootfs");
        execFileSync("debugfs", ["-w", "-R", `write ${unexpected} /unexpected`, rootfs]);
        expect(() =>
          execFileSync("node", ["scripts/check-agent-runtime-rootfs-inventory.mjs", rootfs], {
            encoding: "utf8",
          }),
        ).toThrow(/inventory differs/u);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

function commandAvailable(command: string): boolean {
  return spawnSync("bash", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}
