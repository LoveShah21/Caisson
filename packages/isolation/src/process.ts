import { spawn } from "node:child_process";

import { CaissonError } from "@caisson/protocol";

import type { ExecResult } from "./types.js";

export async function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<ExecResult> {
  const startedAt = performance.now();

  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(
        new CaissonError("SANDBOX_FAILED", "sandbox command could not start", undefined, error),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new CaissonError("SANDBOX_FAILED", "sandbox command timed out"));
        return;
      }
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
  });
}
