import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CAISSON_INFRA_PROBE_PORT,
  VsockInfrastructureProbe,
} from "../../packages/isolation/src/vsock-infrastructure-probe.js";

function windowsSocketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\caisson-vsock-probe-${process.pid}-${Date.now()}`;
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

describe("vsock infrastructure probe", () => {
  it("retries readiness until a delayed guest completes a probe command", async () => {
    const socketDirectory =
      process.platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "caisson-vsock-"));
    const path =
      socketDirectory === undefined
        ? windowsSocketPath()
        : join(socketDirectory, "delayed-vsock.sock");
    let attempts = 0;
    const server = net.createServer((socket) => {
      attempts += 1;
      const closeAfterHandshake = attempts === 1;
      let received = "";
      let connected = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received += chunk;
        const newline = received.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = received.slice(0, newline);
        received = received.slice(newline + 1);
        if (!connected) {
          expect(line).toBe(`CONNECT ${CAISSON_INFRA_PROBE_PORT}`);
          connected = true;
          socket.write("OK 12345\n");
          return;
        }
        expect(JSON.parse(line)).toEqual({ argv: ["/bin/echo"] });
        if (closeAfterHandshake) {
          socket.destroy();
          return;
        }
        socket.write('{"exitCode":0,"stdout":"\\n","stderr":""}\n');
      });
    });
    let listening = false;

    try {
      const probe = new VsockInfrastructureProbe();
      const delayedServer = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          listen(server, path)
            .then(() => {
              listening = true;
              resolve();
            })
            .catch(reject);
        }, 50);
      });
      await expect(
        Promise.all([
          delayedServer,
          probe.waitForReady({ port: CAISSON_INFRA_PROBE_PORT, vsockPath: path }, 1_000),
        ]),
      ).resolves.toHaveLength(2);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      if (listening) {
        await close(server);
      }
      if (socketDirectory !== undefined) {
        await rm(socketDirectory, { force: true, recursive: true });
      }
    }
  });

  it("waits for the Firecracker CONNECT acknowledgement before sending JSON", async () => {
    const socketDirectory =
      process.platform === "win32" ? undefined : await mkdtemp(join(tmpdir(), "caisson-vsock-"));
    const path =
      socketDirectory === undefined
        ? windowsSocketPath()
        : join(socketDirectory, "firecracker-vsock.sock");
    const server = net.createServer((socket) => {
      let received = "";
      let connected = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received += chunk;
        if (!connected) {
          const newline = received.indexOf("\n");
          if (newline === -1) {
            return;
          }
          const connectLine = received.slice(0, newline + 1);
          const trailingData = received.slice(newline + 1);
          if (connectLine !== `CONNECT ${CAISSON_INFRA_PROBE_PORT}\n` || trailingData !== "") {
            socket.destroy();
            return;
          }
          connected = true;
          received = "";
          socket.write("OK 12345\n");
          return;
        }

        const newline = received.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const request: unknown = JSON.parse(received.slice(0, newline));
        expect(request).toEqual({ argv: ["/bin/echo", "hello"] });
        socket.write('{"exitCode":0,"stdout":"hello\\n","stderr":""}\n');
      });
    });

    try {
      await listen(server, path);
      const probe = new VsockInfrastructureProbe();
      await expect(
        probe.execute(
          { driver: "firecracker", id: "probe-test" },
          { argv: ["/bin/echo", "hello"], timeoutMs: 1_000 },
          { port: CAISSON_INFRA_PROBE_PORT, vsockPath: path },
        ),
      ).resolves.toMatchObject({ exitCode: 0, stderr: "", stdout: "hello\n" });
    } finally {
      await close(server);
      if (socketDirectory !== undefined) {
        await rm(socketDirectory, { force: true, recursive: true });
      }
    }
  });
});
