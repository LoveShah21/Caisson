import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContainerDriver } from "../../packages/isolation/src/container-driver.js";
import { runCommand } from "../../packages/isolation/src/process.js";
import type { TransportDescriptor, TransportHost } from "../../packages/isolation/src/types.js";

vi.mock("../../packages/isolation/src/process.js", () => ({ runCommand: vi.fn() }));

describe("ContainerDriver failed prepare cleanup", () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockReset();
  });

  it("removes a possible partial container before releasing an unstarted transport reservation", async () => {
    const release = vi.fn<TransportHost["release"]>().mockResolvedValue();
    const transportHost: TransportHost = {
      reserve: async (descriptor) => ({ descriptor, endpointPath: descriptor.peerIdentifier }),
      release,
    };
    const transportDirectory = join(process.cwd(), ".test-tmp-container-rollback");
    await mkdir(transportDirectory, { recursive: true });
    const driver = new ContainerDriver({
      dockerPath: "docker",
      transportDirectory,
      warn: () => undefined,
    });
    vi.mocked(runCommand)
      .mockResolvedValueOnce({ durationMs: 1, exitCode: 1, stderr: "create failed", stdout: "" })
      .mockResolvedValueOnce({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" });

    try {
      await expect(
        driver.prepare({ id: randomUUID(), image: "not-a-node-module" }, transportHost),
      ).rejects.toMatchObject({ code: "SANDBOX_FAILED" });

      expect(runCommand).toHaveBeenCalledTimes(2);
      expect(runCommand).toHaveBeenNthCalledWith(2, "docker", ["rm", "-f", expect.any(String)]);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "unix" }) as TransportDescriptor,
      );
    } finally {
      await rm(transportDirectory, { force: true, recursive: true });
    }
  });
});
