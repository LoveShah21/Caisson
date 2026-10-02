import net from "node:net";

import { CaissonError } from "@caisson/protocol";

export const CAISSON_RUNTIME_DIAGNOSTIC_PORT = 1026;

export type RuntimeDiagnosticRequest =
  | { readonly operation: "random" }
  | {
      readonly operation: "write_marker";
      readonly path: "/dev/shm/caisson-marker";
      readonly value: string;
    }
  | { readonly operation: "read_marker"; readonly path: "/dev/shm/caisson-marker" }
  | { readonly operation: "continue_broker" }
  | { readonly operation: "scan_canary" }
  | { readonly operation: "network_probe"; readonly value: "node" | "python3" }
  | { readonly operation: "agent_tool"; readonly value: string }
  | { readonly operation: "agent_socket_stat" };

export async function callRuntimeDiagnostic(
  vsockPath: string,
  request: RuntimeDiagnosticRequest,
): Promise<{ ok: boolean; value?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(vsockPath);
    let received = "";
    let sent = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CaissonError("SANDBOX_FAILED", "runtime diagnostic timed out"));
    }, 5_000);
    const fail = (error: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new CaissonError("SANDBOX_FAILED", "runtime diagnostic failed", undefined, error));
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`CONNECT ${CAISSON_RUNTIME_DIAGNOSTIC_PORT}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      const line = received.slice(0, newline);
      if (!sent) {
        if (!/^OK \d+$/u.test(line)) return fail("CONNECT not acknowledged");
        sent = true;
        received = received.slice(newline + 1);
        socket.write(`${JSON.stringify(request)}\n`);
        return;
      }
      try {
        const response: unknown = JSON.parse(line);
        if (typeof response !== "object" || response === null) {
          return fail("invalid diagnostic response");
        }
        if ((response as { ok?: unknown }).ok !== true) {
          const error = (response as { error?: unknown }).error;
          return fail(typeof error === "string" ? error : "invalid diagnostic response");
        }
        clearTimeout(timer);
        socket.destroy();
        resolve(response as { ok: boolean; value?: string });
      } catch (error) {
        fail(error);
      }
    });
    socket.once("error", fail);
  });
}
