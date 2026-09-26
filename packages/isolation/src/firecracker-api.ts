import net from "node:net";

import { CaissonError } from "@caisson/protocol";

interface ApiResponse {
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
    "Connection: close",
    "",
    payload,
  ].join("\r\n");

  return new Promise<ApiResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new CaissonError("SANDBOX_FAILED", "Firecracker API request timed out"));
    }, 5_000);

    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(
        new CaissonError("SANDBOX_FAILED", "Firecracker API is unavailable", undefined, error),
      );
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      const firstLine = response.split("\r\n", 1)[0];
      const match = /^HTTP\/1\.1\s+(\d{3})\b/u.exec(firstLine ?? "");
      if (match?.[1] === undefined) {
        reject(new CaissonError("SANDBOX_FAILED", "Firecracker API returned an invalid response"));
        return;
      }
      const statusCode = Number.parseInt(match[1], 10);
      if (statusCode < 200 || statusCode >= 300) {
        reject(
          new CaissonError("SANDBOX_FAILED", `Firecracker API request failed with ${statusCode}`),
        );
        return;
      }
      resolve({ statusCode });
    });
  });
}
