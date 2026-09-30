import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TransportAttachment, TransportDescriptor, TransportHost } from "@caisson/isolation";

import type { BrokerPipeline } from "./broker-pipeline.js";
import { FramedBrokerServer } from "./framed-broker-server.js";

export const CAISSON_BROKER_VSOCK_PORT = 1024;

/** Host-side listener for guest-initiated Firecracker vsock connections. */
export class FirecrackerBrokerTransportHost implements TransportHost {
  readonly #pipeline: BrokerPipeline;
  readonly #runtimeDirectory: string;
  readonly #servers = new Map<string, FramedBrokerServer>();

  constructor(options: { pipeline: BrokerPipeline; runtimeDirectory: string }) {
    this.#pipeline = options.pipeline;
    this.#runtimeDirectory = options.runtimeDirectory;
  }

  async reserve(descriptor: TransportDescriptor): Promise<TransportAttachment> {
    if (descriptor.kind !== "vsock") throw new Error("Firecracker transport requires vsock");
    const endpointPath = join(this.#runtimeDirectory, `${descriptor.peerIdentifier}.vsock`);
    const listenerPath = `${endpointPath}_${CAISSON_BROKER_VSOCK_PORT}`;
    await mkdir(dirname(endpointPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(endpointPath), 0o700);
    const server = new FramedBrokerServer({
      endpointPath: listenerPath,
      peer: {
        hostId: descriptor.hostId,
        transportKind: "vsock",
        peerIdentifier: descriptor.peerIdentifier,
      },
      readTimeoutMs: 5_000,
      handle: (peer, payload) => this.#pipeline.handle(peer, payload),
    });
    await server.listen();
    await chmod(listenerPath, 0o600);
    this.#servers.set(descriptor.peerIdentifier, server);
    return { descriptor, endpointPath };
  }

  async release(descriptor: TransportDescriptor): Promise<void> {
    const server = this.#servers.get(descriptor.peerIdentifier);
    if (server !== undefined) await server.close();
    this.#servers.delete(descriptor.peerIdentifier);
    const endpointPath = join(this.#runtimeDirectory, `${descriptor.peerIdentifier}.vsock`);
    await Promise.all([
      rm(`${endpointPath}_${CAISSON_BROKER_VSOCK_PORT}`, { force: true }),
      rm(endpointPath, { force: true }),
    ]);
  }
}
