import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { firecrackerProcessSpawnOptions } from "../../packages/isolation/src/firecracker-driver.js";

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

describe("Firecracker process launching", () => {
  it("disconnects standard input and captures standard output and error in a log file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caisson-firecracker-process-"));
    const logPath = join(directory, "firecracker.log");
    const logFile = await open(logPath, "a");
    try {
      const child = spawn(
        process.execPath,
        ["-e", "process.stdout.write('stdout'); process.stderr.write('stderr')"],
        firecrackerProcessSpawnOptions(logFile.fd),
      );
      await expect(waitForExit(child)).resolves.toBe(0);
    } finally {
      await logFile.close();
    }

    try {
      await expect(readFile(logPath, "utf8")).resolves.toContain("stdout");
      await expect(readFile(logPath, "utf8")).resolves.toContain("stderr");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
