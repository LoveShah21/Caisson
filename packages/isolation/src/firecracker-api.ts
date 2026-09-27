import net from "node:net";

import { CaissonError } from "@caisson/protocol";

interface ApiResponse {
  readonly statusCode: number;
}

interface ParsedResponseHead {
  readonly contentLength?: number;
  readonly headerEnd: number;
  readonly statusCode: number;
}

export async function callFirecrackerApi(
  socketPath: string,
  method: "GET" | "PATCH" | "PUT",
  path: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<ApiResponse> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const request = [
    `${method} ${path} HTTP/1.1`,
    "Host: localhost",
    "Accept: application/json",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(payload)}`,
    "",
    payload,
  ].join("\r\n");

  return new Promise<ApiResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = Buffer.alloc(0);
    let responseHead: ParsedResponseHead | undefined;
    let settled = false;

    const settle = (result: ApiResponse | CaissonError): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (result instanceof CaissonError) {
        reject(result);
        return;
      }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      settle(
        new CaissonError("SANDBOX_FAILED", `Firecracker API request timed out: ${method} ${path}`),
      );
    }, 5_000);

    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      try {
        responseHead ??= parseResponseHead(response);
      } catch (error: unknown) {
        const cause = error instanceof Error ? error : undefined;
        settle(
          new CaissonError(
            "SANDBOX_FAILED",
            "Firecracker API returned an invalid response",
            undefined,
            cause,
          ),
        );
        return;
      }

      if (responseHead === undefined) {
        return;
      }
      if (responseHead.statusCode < 200 || responseHead.statusCode >= 300) {
        settle(
          new CaissonError(
            "SANDBOX_FAILED",
            `Firecracker API request failed with ${responseHead.statusCode}`,
          ),
        );
        return;
      }

      const bodyLength = response.length - responseHead.headerEnd;
      if (
        responseHead.contentLength === undefined
          ? statusNeverHasBody(responseHead.statusCode)
          : bodyLength >= responseHead.contentLength
      ) {
        settle({ statusCode: responseHead.statusCode });
      }
    });
    socket.once("error", (error: Error) => {
      settle(
        new CaissonError("SANDBOX_FAILED", "Firecracker API is unavailable", undefined, error),
      );
    });
    socket.once("close", () => {
      if (!settled) {
        settle(new CaissonError("SANDBOX_FAILED", "Firecracker API closed before a full response"));
      }
    });
  });
}

function parseResponseHead(response: Buffer): ParsedResponseHead | undefined {
  const separator = response.indexOf("\r\n\r\n");
  if (separator === -1) {
    return undefined;
  }
  const lines = response.subarray(0, separator).toString("latin1").split("\r\n");
  const statusLine = lines.shift();
  const statusMatch = /^HTTP\/1\.1\s+(\d{3})\b/u.exec(statusLine ?? "");
  if (statusMatch?.[1] === undefined) {
    throw new CaissonError("SANDBOX_FAILED", "Firecracker API returned an invalid status line");
  }
  const statusCode = Number.parseInt(statusMatch[1], 10);
  let contentLength: number | undefined;
  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    if (name !== "content-length") {
      continue;
    }
    const value = line.slice(separatorIndex + 1).trim();
    if (!/^\d+$/u.test(value)) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "Firecracker API returned an invalid content length",
      );
    }
    const parsedContentLength = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsedContentLength)) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "Firecracker API returned an invalid content length",
      );
    }
    contentLength = parsedContentLength;
  }
  return contentLength === undefined
    ? { headerEnd: separator + 4, statusCode }
    : { contentLength, headerEnd: separator + 4, statusCode };
}

function statusNeverHasBody(statusCode: number): boolean {
  return (statusCode >= 100 && statusCode < 200) || statusCode === 204 || statusCode === 304;
}
