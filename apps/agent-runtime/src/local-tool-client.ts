import net from "node:net";

import {
  type AgentOperationRequest,
  AgentOperationRequestSchema,
  type AgentOperationResponse,
  AgentOperationResponseSchema,
  decodeBrokerFrameLength,
  encodeBrokerFrame,
} from "@caisson/protocol";

export const AGENT_SOCKET_PATH = "/run/caisson/agent.sock";

export interface LocalToolClientOptions {
  readonly socketPath?: string;
  readonly timeoutMs: number;
}

/** Guest-agent client. It has no host transport or broker capability. */
export class LocalToolClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;

  constructor(options: LocalToolClientOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
      throw new Error("local tool client timeout must be positive");
    this.#socketPath = options.socketPath ?? AGENT_SOCKET_PATH;
    this.#timeoutMs = options.timeoutMs;
  }

  async call(request: AgentOperationRequest): Promise<AgentOperationResponse> {
    const validated = AgentOperationRequestSchema.parse(request);
    return new Promise<AgentOperationResponse>((resolve, reject) => {
      const socket = net.createConnection(this.#socketPath);
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        callback();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("local tool socket response timed out"))),
        this.#timeoutMs,
      );
      socket.once("error", (error) => finish(() => reject(error)));
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        let length: number;
        try {
          length = decodeBrokerFrameLength(buffer.subarray(0, 4));
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        if (buffer.length < 4 + length) return;
        if (buffer.length !== 4 + length) {
          finish(() => reject(new Error("local tool socket sent more than one response frame")));
          return;
        }
        try {
          const response = AgentOperationResponseSchema.parse(
            JSON.parse(buffer.subarray(4).toString("utf8")),
          );
          if (response.id !== validated.id)
            throw new Error("local tool response id does not match request");
          finish(() => resolve(response));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.once("connect", () => socket.write(encodeBrokerFrame(JSON.stringify(validated))));
      socket.once("end", () => {
        if (!settled)
          finish(() => reject(new Error("local tool socket closed without a response")));
      });
    });
  }
}
