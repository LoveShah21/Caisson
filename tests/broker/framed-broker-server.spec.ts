import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertBrokerResponseCapacity,
  FramedBrokerServer,
} from "../../apps/broker/src/framed-broker-server.js";
import {
  BROKER_FRAME_MAX_BYTES,
  BrokerCallRequestSchema,
  encodeBrokerFrame,
} from "../../packages/protocol/src/index.js";

let server: FramedBrokerServer | undefined;
let endpointPath = "";

afterEach(async () => {
  await server?.close();
  server = undefined;
  endpointPath = "";
});

describe("FramedBrokerServer", () => {
  it("accepts a payload at the 16 MiB boundary", async () => {
    server = await startServer();
    const payload = `"${"x".repeat(BROKER_FRAME_MAX_BYTES - 2)}"`;
    const response = await exchange(
      endpointPath,
      Buffer.concat([prefix(payload.length), Buffer.from(payload)]),
    );
    expect(response.length).toBeGreaterThan(4);
  }, 30_000);

  it("silently closes a declared payload above the maximum", async () => {
    server = await startServer();
    const response = await exchange(endpointPath, prefix(BROKER_FRAME_MAX_BYTES + 1));
    expect(response).toHaveLength(0);
  });

  it("silently closes a truncated payload", async () => {
    server = await startServer();
    const socket = net.createConnection(endpointPath);
    await once(socket, "connect");
    socket.write(Buffer.concat([prefix(8), Buffer.from("{}")]));
    socket.end();
    const response = await readAll(socket);
    expect(response).toHaveLength(0);
  });

  it("silently closes a garbage length prefix", async () => {
    server = await startServer();
    const response = await exchange(endpointPath, Buffer.from([255, 255, 255, 255]));
    expect(response).toHaveLength(0);
  });

  it("returns one diagnostic frame then closes for non-JSON payload", async () => {
    server = await startServer();
    const response = await exchange(endpointPath, encodeBrokerFrame("not json"));
    expect(JSON.parse(response.subarray(4).toString("utf8"))).toMatchObject({
      error: { code: "PARAMS_INVALID" },
    });
  });

  it("returns one diagnostic frame then closes for schema-invalid JSON", async () => {
    server = await startServer();
    const response = await exchange(endpointPath, encodeBrokerFrame(JSON.stringify({ id: "x" })));
    expect(JSON.parse(response.subarray(4).toString("utf8"))).toMatchObject({
      error: { code: "PARAMS_INVALID" },
    });
  });

  it("closes a slow-loris payload after the configured read timeout", async () => {
    server = await startServer(20);
    const socket = net.createConnection(endpointPath);
    await once(socket, "connect");
    socket.write(prefix(10));
    const responsePromise = readAll(socket);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    const response = await responsePromise;
    expect(response).toHaveLength(0);
  });

  it("validates configured adapter caps against the protocol ceiling", () => {
    expect(() => assertBrokerResponseCapacity([10 * 1024 * 1024])).not.toThrow();
    expect(() => assertBrokerResponseCapacity([13 * 1024 * 1024])).toThrow(
      "configured adapter response cannot fit in a broker frame",
    );
  });
});

async function startServer(readTimeoutMs = 500): Promise<FramedBrokerServer> {
  endpointPath = endpoint();
  const instance = new FramedBrokerServer({
    endpointPath,
    peer: { hostId: "test-host", transportKind: "unix", peerIdentifier: "test-peer" },
    readTimeoutMs,
    handle: async (_peer, payload) => {
      const request = BrokerCallRequestSchema.parse(payload);
      return {
        id: request.id,
        ok: true,
        body: {
          result: null,
          meta: {
            actionId: "018f0000-0000-7000-8000-000000000400",
            durationMs: 0,
            redactionCount: 0,
            roleUsed: "default",
          },
        },
      };
    },
  });
  await instance.listen();
  return instance;
}

function endpoint(): string {
  return `\\\\.\\pipe\\caisson-framing-${randomUUID()}`;
}

function prefix(length: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(length);
  return buffer;
}

async function exchange(path: string, frame: Buffer): Promise<Buffer> {
  const socket = net.createConnection(path);
  await once(socket, "connect");
  socket.end(frame);
  return readAll(socket);
}

async function readAll(socket: net.Socket): Promise<Buffer> {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await once(socket, "close");
  return Buffer.concat(chunks);
}

async function once(socket: net.Socket, event: "connect" | "close"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once(event, resolve);
    socket.once("error", reject);
  });
}
