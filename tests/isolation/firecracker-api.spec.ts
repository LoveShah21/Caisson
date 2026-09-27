import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { callFirecrackerApi } from "../../packages/isolation/src/firecracker-api.js";

function windowsSocketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\caisson-firecracker-api-${process.pid}-${Date.now()}`;
  }
  return "";
}

async function listen(server: net.Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("Firecracker API client", () => {
  it("accepts a complete 204 response without waiting for the server to close", async () => {
    const socketDirectory =
      process.platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "caisson-api-"));
    const path =
      socketDirectory === undefined
        ? windowsSocketPath()
        : join(socketDirectory, "firecracker.sock");
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 204 No Content\r\nContent-");
        setTimeout(() => {
          socket.write("Length: 0\r\n\r\n");
        }, 10);
      });
    });

    try {
      await listen(server, path);
      await expect(callFirecrackerApi(path, "PUT", "/machine-config", {})).resolves.toEqual({
        statusCode: 204,
      });
    } finally {
      await close(server);
      if (socketDirectory !== undefined) {
        await rm(socketDirectory, { force: true, recursive: true });
      }
    }
  });
});
