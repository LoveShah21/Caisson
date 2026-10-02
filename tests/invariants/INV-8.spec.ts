/**
 * INV-8. Subprocess allowlist holds.
 * Only allowlisted binaries execute, git is fetch-only, and no shell is invoked.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync("guest/runtime/agent-socket_linux.go", "utf8");

describe("INV-8: subprocess allowlist holds", () => {
  it("pins allowlisted executables and starts children without a shell or inherited loader state", () => {
    expect(source).toContain("func allowedExecutable(command string, args []string)");
    expect(source).toContain("inode(info) != executableInodes[path]");
    expect(source).toContain('command == "git" && !allowedGit(args)');
    expect(source).toContain("exec.CommandContext(executionContext, path, args...)");
    expect(source).not.toContain("sh -c");
    expect(source).toContain('"PATH=/usr/local/bin:/usr/bin:/bin"');
    expect(source).not.toContain("LD_PRELOAD");
    expect(source).not.toContain("LD_LIBRARY_PATH");
    expect(source).not.toContain("NODE_OPTIONS");
    expect(source).not.toContain("PYTHONSTARTUP");
  });
});
