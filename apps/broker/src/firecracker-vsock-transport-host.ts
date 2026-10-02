import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TransportAttachment, TransportDescriptor, TransportHost } from "@caisson/isolation";

import type { BrokerPipeline } from "./broker-pipeline.js";
import { FramedBrokerServer } from "./framed-broker-server.js";
import type { LocalToolPipeline } from "./local-tool-pipeline.js";
import { LocalToolServer } from "./local-tool-server.js";

export const CAISSON_BROKER_VSOCK_PORT = 1024;
export const CAISSON_LOCAL_TOOL_VSOCK_PORT = 1027;

export interface LocalToolListenerOptions {
  readonly pipeline: LocalToolPipeline;
  readonly frameReadTimeoutMs: number;
  readonly completionTimeoutMs: number;
}

/** Host-side listener for guest-initiated Firecracker vsock connections. */
export class FirecrackerBrokerTransportHost implements TransportHost {
  readonly #pipeline: BrokerPipeline;
  readonly #runtimeDirectory: string;
  readonly #localTools: LocalToolListenerOptions | undefined;
  readonly #servers = new Map<string, FramedBrokerServer>();
  readonly #localToolServers = new Map<string, LocalToolServer>();

  constructor(options: {
    pipeline: BrokerPipeline;
    runtimeDirectory: string;
    localTools?: LocalToolListenerOptions;
  }) {
    this.#pipeline = options.pipeline;
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#localTools = options.localTools;
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
    if (this.#localTools !== undefined) {
      const localToolListenerPath = `${endpointPath}_${CAISSON_LOCAL_TOOL_VSOCK_PORT}`;
      const localToolServer = new LocalToolServer({
        endpointPath: localToolListenerPath,
        peer: {
          hostId: descriptor.hostId,
          transportKind: "vsock",
          peerIdentifier: descriptor.peerIdentifier,
        },
        frameReadTimeoutMs: this.#localTools.frameReadTimeoutMs,
        completionTimeoutMs: this.#localTools.completionTimeoutMs,
        pipeline: this.#localTools.pipeline,
      });
      try {
        await localToolServer.listen();
        await chmod(localToolListenerPath, 0o600);
        this.#localToolServers.set(descriptor.peerIdentifier, localToolServer);
      } catch (error) {
        await server.close();
        this.#servers.delete(descriptor.peerIdentifier);
        await rm(listenerPath, { force: true });
        throw error;
      }
    }
    return { descriptor, endpointPath };
  }

  async release(descriptor: TransportDescriptor): Promise<void> {
    const server = this.#servers.get(descriptor.peerIdentifier);
    if (server !== undefined) await server.close();
    const localToolServer = this.#localToolServers.get(descriptor.peerIdentifier);
    if (localToolServer !== undefined) await localToolServer.close();
    this.#servers.delete(descriptor.peerIdentifier);
    this.#localToolServers.delete(descriptor.peerIdentifier);
    const endpointPath = join(this.#runtimeDirectory, `${descriptor.peerIdentifier}.vsock`);
    await Promise.all([
      rm(`${endpointPath}_${CAISSON_BROKER_VSOCK_PORT}`, { force: true }),
      rm(`${endpointPath}_${CAISSON_LOCAL_TOOL_VSOCK_PORT}`, { force: true }),
      rm(endpointPath, { force: true }),
    ]);
  }

  /** Host-only test and lifecycle access to Firecracker's private UDS attachment. */
  endpointFor(descriptor: TransportDescriptor): string {
    if (!this.#servers.has(descriptor.peerIdentifier))
      throw new Error("Firecracker transport attachment is not reserved");
    return join(this.#runtimeDirectory, `${descriptor.peerIdentifier}.vsock`);
  }
}
