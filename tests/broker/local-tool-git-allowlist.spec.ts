import { describe, expect, it } from "vitest";

import { assertAllowedExec } from "../../apps/broker/src/local-tool-pipeline.js";

describe("host proc.exec git arguments", () => {
  it("allows only the reviewed HTTPS fetch/clone and read-only forms", () => {
    for (const argv of [
      ["git", "fetch", "https://example.com/repo"],
      ["git", "clone", "https://example.com/repo", "repo"],
      ["git", "status", "--short"],
      ["git", "log", "--oneline"],
      ["git", "diff", "--stat"],
    ]) {
      expect(() => assertAllowedExec(argv)).not.toThrow();
    }
    for (const argv of [
      ["git", "push"],
      ["git", "-c", "core.hooksPath=/workspace", "status"],
      ["git", "fetch", "ext::sh -c id"],
      ["git", "clone", "file:///workspace/repo"],
      ["git", "clone", "https://example.com/repo", "../outside"],
      ["git", "diff", "--ext-diff"],
      ["git", "status", "--untracked-files=all"],
    ]) {
      expect(() => assertAllowedExec(argv)).toThrow();
    }
  });
});
