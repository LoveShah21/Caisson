import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BrokerCallRequestSchema,
  BrokerCallResponseSchema,
  decodeBrokerFrameLength,
  encodeBrokerFrame,
  type BrokerCallRequest,
} from "../../packages/protocol/src/index.js";
import type {
  TransportAttachment,
  TransportDescriptor,
  TransportHost,
} from "../../packages/isolation/src/index.js";

/**
 * KVM-only mechanism fixture. It owns the host endpoint Firecracker exposes
 * to the guest and records every guest-visible message for snapshot checks.
 */
export class RuntimeVsockTransportHost implements TransportHost {
  readonly messages: string[] = [];
  readonly #attachments = new Map<string, TransportAttachment>();
  readonly #servers = new Map<string, net.Server>();
  readonly #root = join(tmpdir(), "caisson-runtime-vsock-tests", randomUUID());

  async reserve(descriptor: TransportDescriptor): Promise<TransportAttachment> {
    if (descriptor.kind !== "vsock") throw new Error("runtime fixture requires a vsock descriptor");
    const endpointPath = join(this.#root, `${descriptor.peerIdentifier}.sock`);
    await mkdir(dirname(endpointPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(endpointPath), 0o700);
    const server = net.createServer((socket) => this.#handle(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(`${endpointPath}_1024`, () => resolve());
    });
    await chmod(`${endpointPath}_1024`, 0o600);
    const attachment = { descriptor, endpointPath };
    this.#attachments.set(descriptor.peerIdentifier, attachment);
    this.#servers.set(descriptor.peerIdentifier, server);
    return attachment;
  }

  async release(descriptor: TransportDescriptor): Promise<void> {
    const server = this.#servers.get(descriptor.peerIdentifier);
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    const attachment = this.#attachments.get(descriptor.peerIdentifier);
    if (attachment !== undefined) {
      await Promise.all([
        rm(`${attachment.endpointPath}_1024`, { force: true }),
        rm(attachment.endpointPath, { force: true }),
      ]);
    }
    this.#servers.delete(descriptor.peerIdentifier);
    this.#attachments.delete(descriptor.peerIdentifier);
  }

  endpointFor(descriptor: TransportDescriptor): string {
    const attachment = this.#attachments.get(descriptor.peerIdentifier);
    if (attachment === undefined) throw new Error("runtime vsock attachment is not reserved");
    return attachment.endpointPath;
  }

  #handle(socket: net.Socket): void {
    const chunks: Buffer[] = [];
    let handled = false;
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      chunks.push(chunk);
      const frame = Buffer.concat(chunks);
      if (frame.length < 4) return;
      let length: number;
      try {
        length = decodeBrokerFrameLength(frame.subarray(0, 4));
      } catch {
        return socket.destroy();
      }
      if (frame.length < length + 4) return;
      if (frame.length !== length + 4) return socket.destroy();
      handled = true;
      let request: BrokerCallRequest;
      try {
        request = BrokerCallRequestSchema.parse(JSON.parse(frame.subarray(4).toString("utf8")));
      } catch {
        return socket.destroy();
      }
      this.messages.push(JSON.stringify(request));
      const response = BrokerCallResponseSchema.parse({
        id: request.id,
        ok: true,
        body: {
          result: { status: "runtime-test-ok" },
          meta: {
            durationMs: 0,
            redactionCount: 0,
            roleUsed: "runtime-test",
            actionId: "018f0000-0000-7000-8000-000000000701",
          },
        },
      });
      const encoded = encodeBrokerFrame(JSON.stringify(response));
      this.messages.push(JSON.stringify(response));
      socket.end(encoded);
    });
  }
}
