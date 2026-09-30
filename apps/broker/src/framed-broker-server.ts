import net from "node:net";
import type { TransportPeer } from "@caisson/control-plane";
import {
  BROKER_FRAME_MAX_BYTES,
  type BrokerCallResponse,
  decodeBrokerFrameLength,
  ErrorResponseSchema,
  encodeBrokerFrame,
} from "@caisson/protocol";

export interface FramedBrokerServerOptions {
  readonly endpointPath: string;
  readonly peer: TransportPeer;
  readonly readTimeoutMs: number;
  readonly handle: (peer: TransportPeer, payload: unknown) => Promise<BrokerCallResponse>;
}

/** Stage D loopback framing harness. Stage E supplies the live vsock listener. */
export class FramedBrokerServer {
  readonly #options: FramedBrokerServerOptions;
  readonly #server: net.Server;

  constructor(options: FramedBrokerServerOptions) {
    if (!Number.isSafeInteger(options.readTimeoutMs) || options.readTimeoutMs <= 0) {
      throw new Error("broker frame read timeout must be a positive integer");
    }
    this.#options = options;
    this.#server = net.createServer((socket) => this.#handleSocket(socket));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#options.endpointPath, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  #handleSocket(socket: net.Socket): void {
    let received = Buffer.alloc(0);
    let declaredLength: number | undefined;
    let handled = false;
    socket.setTimeout(this.#options.readTimeoutMs, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      received = Buffer.concat([received, chunk]);
      if (declaredLength === undefined && received.length >= 4) {
        try {
          declaredLength = decodeBrokerFrameLength(received.subarray(0, 4));
        } catch {
          socket.destroy();
          return;
        }
      }
      if (declaredLength === undefined || received.length < 4 + declaredLength) return;
      if (received.length !== 4 + declaredLength) {
        socket.destroy();
        return;
      }
      handled = true;
      socket.setTimeout(0);
      void this.#dispatch(socket, received.subarray(4));
    });
    socket.on("end", () => {
      if (!handled) socket.destroy();
    });
  }

  async #dispatch(socket: net.Socket, payload: Buffer): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString("utf8"));
    } catch {
      this.#writeMalformedFrame(socket);
      return;
    }
    try {
      const response = await this.#options.handle(this.#options.peer, parsed);
      socket.end(encodeBrokerFrame(JSON.stringify(response)));
    } catch {
      this.#writeMalformedFrame(socket);
    }
  }

  #writeMalformedFrame(socket: net.Socket): void {
    if (socket.destroyed || !socket.writable) {
      socket.destroy();
      return;
    }
    const response = ErrorResponseSchema.parse({
      error: {
        code: "PARAMS_INVALID",
        message: "invalid broker frame payload",
        details: {},
        traceId: "unavailable",
      },
    });
    socket.end(encodeBrokerFrame(JSON.stringify(response)));
  }
}

export function assertBrokerResponseCapacity(adapterResponseMaximums: readonly number[]): void {
  for (const maximum of adapterResponseMaximums) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error("adapter response maximum must be a positive integer");
    }
    // Base64 is the largest approved binary encoding. The envelope covers the
    // fixed broker response structure plus bounded ids, headers, and metadata.
    const worstCase = Math.ceil(maximum / 3) * 4 + 8_192;
    if (worstCase > BROKER_FRAME_MAX_BYTES) {
      throw new Error("configured adapter response cannot fit in a broker frame");
    }
  }
}
