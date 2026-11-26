/**
 * Structural check for the direct-launch guard only. ADR-53 blocks INV-8:
 * an authorized language runtime can still execute an anonymous memfd.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync("guest/runtime/agent-socket_linux.go", "utf8");

describe("guest direct-launch guard", () => {
  it("guards the direct-launch allowlist while the full invariant remains blocked by ADR-53", () => {
    expect(source).toContain("func allowedExecutable(command string, args []string)");
    expect(source).toContain("inode(info) != executableInodes[path]");
    expect(source).toContain('command == "git" && !allowedGit(args)');
    expect(source).toContain(
      "exec.CommandContext(executionContext, path, gitSafeArguments(command, args)...)",
    );
    expect(source).not.toContain("sh -c");
    expect(source).toContain('"PATH=/usr/local/bin:/usr/bin:/bin"');
    expect(source).not.toContain("LD_PRELOAD");
    expect(source).not.toContain("LD_LIBRARY_PATH");
    expect(source).not.toContain("NODE_OPTIONS");
    expect(source).not.toContain("PYTHONSTARTUP");
  });
});
