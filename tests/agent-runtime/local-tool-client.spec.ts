import { randomUUID } from "node:crypto";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { LocalToolClient } from "../../apps/agent-runtime/src/local-tool-client.js";
import { decodeBrokerFrameLength, encodeBrokerFrame } from "../../packages/protocol/src/index.js";

let server: net.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (server === undefined) return resolve();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  server = undefined;
});

describe("LocalToolClient", () => {
  it("uses one local framed request and validates the matching response", async () => {
    const socketPath = endpointPath();
    const received = new Promise<unknown>((resolve, reject) => {
      server = net.createServer((socket) => {
        let buffered = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          try {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.length < 4) return;
            const length = decodeBrokerFrameLength(buffered.subarray(0, 4));
            if (buffered.length < length + 4) return;
            if (buffered.length !== length + 4) throw new Error("unexpected extra client frame");
            const request = JSON.parse(buffered.subarray(4).toString("utf8"));
            resolve(request);
            socket.end(
              encodeBrokerFrame(
                JSON.stringify({
                  id: request.id,
                  ok: true,
                  body: {
                    result: { content: "hello", bytes: 5 },
                    meta: {
                      actionId: "018f0000-0000-7000-8000-000000000401",
                      durationMs: 1,
                    },
                  },
                }),
              ),
            );
          } catch (error) {
            reject(error);
          }
        });
      });
      server.listen(socketPath);
    });
    await waitForListening(server);
    const client = new LocalToolClient({ socketPath, timeoutMs: 1_000 });
    const result = await client.call({
      id: "local-1",
      op: "fs.read",
      body: { path: "/workspace/example.txt" },
    });

    await expect(received).resolves.toEqual({
      id: "local-1",
      op: "fs.read",
      body: { path: "/workspace/example.txt" },
    });
    expect(result).toMatchObject({ id: "local-1", ok: true });
  });

  it("forwards the existing broker.call shape without exposing a broker endpoint", async () => {
    const socketPath = endpointPath();
    server = net.createServer((socket) => {
      socket.once("data", (chunk: Buffer) => {
        const request = JSON.parse(chunk.subarray(4).toString("utf8"));
        socket.end(
          encodeBrokerFrame(
            JSON.stringify({
              id: request.id,
              ok: true,
              body: {
                result: { rows: [{ value: 1 }] },
                meta: {
                  actionId: "018f0000-0000-7000-8000-000000000402",
                  durationMs: 1,
                  redactionCount: 0,
                  roleUsed: "default",
                },
              },
            }),
          ),
        );
      });
    });
    server.listen(socketPath);
    await waitForListening(server);
    const client = new LocalToolClient({ socketPath, timeoutMs: 1_000 });
    await expect(
      client.call({
        id: "broker-1",
        op: "broker.call",
        body: {
          service: "postgres",
          method: "query",
          params: { sql: "SELECT 1" },
          idempotencyKey: "broker-1",
          intent: "read one row",
        },
      }),
    ).resolves.toMatchObject({ id: "broker-1", ok: true });
  });
});

function endpointPath(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\caisson-agent-client-${randomUUID()}`
    : `/tmp/caisson-agent-client-${randomUUID()}.sock`;
}

async function waitForListening(instance: net.Server): Promise<void> {
  if (instance.listening) return;
  await new Promise<void>((resolve, reject) => {
    instance.once("listening", resolve);
    instance.once("error", reject);
  });
}
