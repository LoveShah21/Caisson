import net from "node:net";

import type { TransportPeer } from "@caisson/control-plane";
import {
  CaissonError,
  decodeBrokerFrameLength,
  encodeBrokerFrame,
  LocalCompletionRequestSchema,
  type LocalToolRequest,
  LocalToolRequestSchema,
  LocalToolResponseSchema,
} from "@caisson/protocol";

import type { LocalToolAuthorization, LocalToolPipeline } from "./local-tool-pipeline.js";

export interface LocalToolServerOptions {
  readonly endpointPath: string;
  readonly peer: TransportPeer;
  readonly frameReadTimeoutMs: number;
  readonly completionTimeoutMs: number;
  readonly pipeline: LocalToolPipeline;
}

/** One local operation per stateful, two-frame connection. */
export class LocalToolServer {
  readonly #options: LocalToolServerOptions;
  readonly #server: net.Server;

  constructor(options: LocalToolServerOptions) {
    assertPositive(options.frameReadTimeoutMs, "local tool frame read timeout");
    assertPositive(options.completionTimeoutMs, "local tool completion timeout");
    this.#options = options;
    this.#server = net.createServer((socket) => void this.#handle(socket));
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

  async #handle(socket: net.Socket): Promise<void> {
    const reader = new FrameReader(socket);
    let request: LocalToolRequest;
    try {
      request = LocalToolRequestSchema.parse(
        parseJson(await reader.next(this.#options.frameReadTimeoutMs)),
      );
    } catch (error) {
      return this.#failInitial(socket, error);
    }
    let authorization: LocalToolAuthorization;
    try {
      authorization = await this.#options.pipeline.authorize(this.#options.peer, request);
    } catch (error) {
      this.#end(socket, localError(request.id, error));
      return;
    }
    if (!this.#write(socket, this.#options.pipeline.authorized(authorization))) {
      await this.#options.pipeline.abandon(authorization, "guest disconnected after authorization");
      return;
    }
    try {
      const completion = LocalCompletionRequestSchema.parse(
        parseJson(await reader.next(this.#options.completionTimeoutMs)),
      );
      this.#end(socket, await this.#options.pipeline.complete(authorization, completion));
    } catch (error) {
      if (error instanceof FrameError && (error.kind === "timeout" || error.kind === "closed")) {
        await this.#options.pipeline.abandon(
          authorization,
          error.kind === "timeout"
            ? "local tool completion timed out"
            : "guest disconnected before local tool completion",
        );
        socket.destroy();
        return;
      }
      const response = await this.#options.pipeline.invalidCompletion(
        authorization,
        "malformed local tool completion",
      );
      if (error instanceof FrameError && error.silent) socket.destroy();
      else this.#end(socket, response);
    }
  }

  #failInitial(socket: net.Socket, error: unknown): void {
    if (error instanceof FrameError && error.silent) socket.destroy();
    else
      this.#end(
        socket,
        localError("unknown", new CaissonError("PARAMS_INVALID", "invalid local tool request")),
      );
  }

  #write(socket: net.Socket, payload: unknown): boolean {
    if (socket.destroyed || !socket.writable) return false;
    socket.write(encodeBrokerFrame(JSON.stringify(payload)));
    return true;
  }

  #end(socket: net.Socket, payload: unknown): void {
    if (socket.destroyed || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end(encodeBrokerFrame(JSON.stringify(payload)));
  }
}

class FrameReader {
  #buffer = Buffer.alloc(0);
  #pending: { resolve(value: Buffer): void; reject(reason: Error): void } | undefined;
  #closed: Error | undefined;

  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#pump();
    });
    socket.once("error", () => this.#close(new FrameError("closed", false)));
    socket.once("end", () => this.#close(new FrameError("closed", false)));
    socket.once("close", () => this.#close(new FrameError("closed", false)));
  }

  next(timeoutMs: number): Promise<Buffer> {
    if (this.#pending !== undefined) throw new Error("concurrent local-tool reads are forbidden");
    if (this.#closed !== undefined) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending !== undefined) {
          this.#pending = undefined;
          reject(new FrameError("timeout", false));
        }
      }, timeoutMs);
      this.#pending = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#pending === undefined || this.#buffer.length < 4) return;
    let size: number;
    try {
      size = decodeBrokerFrameLength(this.#buffer.subarray(0, 4));
    } catch {
      this.#close(new FrameError("malformed", true));
      return;
    }
    if (this.#buffer.length < 4 + size) return;
    const frame = this.#buffer.subarray(4, 4 + size);
    this.#buffer = this.#buffer.subarray(4 + size);
    const pending = this.#pending;
    this.#pending = undefined;
    pending.resolve(frame);
  }

  #close(error: Error): void {
    if (this.#closed !== undefined) return;
    this.#closed = error;
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(error);
  }
}

class FrameError extends Error {
  constructor(
    readonly kind: "timeout" | "closed" | "malformed",
    readonly silent: boolean,
  ) {
    super(kind);
  }
}

function parseJson(frame: Buffer): unknown {
  try {
    return JSON.parse(frame.toString("utf8"));
  } catch {
    throw new FrameError("malformed", false);
  }
}

function localError(id: string, error: unknown) {
  const caisson =
    error instanceof CaissonError ? error : new CaissonError("INTERNAL", "local tool failed");
  const { actionId: possibleActionId } = caisson.details ?? {};
  const actionId = typeof possibleActionId === "string" ? possibleActionId : undefined;
  return LocalToolResponseSchema.parse({
    id,
    ok: false,
    error: {
      code: caisson.code,
      message: caisson.message,
      details: {},
      ...(actionId === undefined ? {} : { actionId }),
    },
  });
}

function assertPositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
}
