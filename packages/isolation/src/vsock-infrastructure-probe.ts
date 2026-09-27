import net from "node:net";

import { CaissonError } from "@caisson/protocol";

import type { InfrastructureProbe, InfrastructureProbeContext } from "./firecracker-driver.js";
import type { ExecRequest, ExecResult, SandboxHandle } from "./types.js";

export const CAISSON_INFRA_PROBE_PORT = 9999;
const READY_PROBE_PAYLOAD = `${JSON.stringify({ argv: ["/bin/echo"] })}\n`;

function parseResponse(value: unknown): ExecResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CaissonError("SANDBOX_FAILED", "development probe returned an invalid response");
  }
  if (!("exitCode" in value && "stdout" in value && "stderr" in value)) {
    throw new CaissonError("SANDBOX_FAILED", "development probe returned an invalid response");
  }
  const { exitCode, stdout, stderr } = value;
  if (
    typeof exitCode !== "number" ||
    !Number.isInteger(exitCode) ||
    typeof stdout !== "string" ||
    typeof stderr !== "string"
  ) {
    throw new CaissonError("SANDBOX_FAILED", "development probe returned an invalid response");
  }
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: 0,
  };
}

/**
 * M-1-only development probe. It must never be configured for production or a
 * broker request path. The guest probe accepts arbitrary argv by design.
 */
export class VsockInfrastructureProbe implements InfrastructureProbe {
  async waitForReady(context: InfrastructureProbeContext, timeoutMs: number): Promise<void> {
    const response = await exchange(
      context.vsockPath,
      context.port,
      READY_PROBE_PAYLOAD,
      timeoutMs,
      true,
    );
    try {
      const result = parseResponse(JSON.parse(response) as unknown);
      if (result.exitCode !== 0) {
        throw new CaissonError("SANDBOX_FAILED", "guest readiness command failed");
      }
    } catch (error: unknown) {
      if (error instanceof CaissonError) {
        throw error;
      }
      throw new CaissonError(
        "SANDBOX_FAILED",
        "guest readiness probe returned invalid JSON",
        undefined,
        error,
      );
    }
  }

  async execute(
    _handle: SandboxHandle,
    request: ExecRequest,
    context: InfrastructureProbeContext,
  ): Promise<ExecResult> {
    const startedAt = performance.now();
    const payload = `${JSON.stringify({ argv: request.argv })}\n`;
    const response = await exchange(
      context.vsockPath,
      context.port,
      payload,
      request.timeoutMs ?? 30_000,
    );
    try {
      const parsed: unknown = JSON.parse(response);
      return { ...parseResponse(parsed), durationMs: Math.round(performance.now() - startedAt) };
    } catch (error: unknown) {
      if (error instanceof CaissonError) {
        throw error;
      }
      throw new CaissonError(
        "SANDBOX_FAILED",
        "development probe returned invalid JSON",
        undefined,
        error,
      );
    }
  }
}

async function exchange(
  socketPath: string,
  port: number,
  payload: string,
  timeoutMs: number,
  retryAfterHandshake = false,
): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  while (performance.now() < deadline) {
    const remainingMs = Math.max(1, Math.round(deadline - performance.now()));
    try {
      return await exchangeOnce(
        socketPath,
        port,
        payload,
        Math.min(remainingMs, 1_000),
        retryAfterHandshake,
      );
    } catch (error: unknown) {
      if (!(error instanceof ProbeConnectionError) || !error.retryable) {
        throw new CaissonError(
          "SANDBOX_FAILED",
          "development probe connection failed",
          undefined,
          error,
        );
      }
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new CaissonError(
    "SANDBOX_FAILED",
    "development probe did not become ready",
    undefined,
    lastError,
  );
}

class ProbeConnectionError extends Error {
  constructor(
    readonly connected: boolean,
    readonly retryable: boolean,
    cause: unknown,
  ) {
    super("development probe connection failed", { cause });
  }
}

async function exchangeOnce(
  socketPath: string,
  port: number,
  payload: string,
  timeoutMs: number,
  retryAfterHandshake: boolean,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let received = "";
    let connected = false;
    let handshakeComplete = false;
    let settled = false;

    const fail = (error: ProbeConnectionError): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    };

    const succeed = (response: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(response);
    };

    const timeout = setTimeout(() => {
      fail(
        new ProbeConnectionError(
          connected,
          !handshakeComplete || retryAfterHandshake,
          "development probe timed out",
        ),
      );
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      connected = true;
      socket.write(`CONNECT ${port}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!handshakeComplete) {
        const newline = received.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const handshake = received.slice(0, newline);
        received = received.slice(newline + 1);
        if (!/^OK \d+$/u.test(handshake)) {
          fail(
            new ProbeConnectionError(true, false, "Firecracker vsock CONNECT was not acknowledged"),
          );
          return;
        }
        handshakeComplete = true;
        socket.write(payload);
      }

      const newline = received.indexOf("\n");
      if (newline !== -1) {
        succeed(received.slice(0, newline));
      }
    });
    socket.once("error", (error: Error) => {
      fail(new ProbeConnectionError(connected, !handshakeComplete || retryAfterHandshake, error));
    });
    socket.once("close", () => {
      if (!settled) {
        fail(
          new ProbeConnectionError(
            connected,
            !handshakeComplete || retryAfterHandshake,
            "development probe connection closed",
          ),
        );
      }
    });
  });
}
