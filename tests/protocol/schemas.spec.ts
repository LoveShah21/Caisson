import { describe, expect, it } from "vitest";

import {
  AgentOperationRequestSchema,
  AgentOperationResponseSchema,
  BrokerFrameIdSchema,
  LocalCompletionRequestSchema,
} from "../../packages/protocol/src/index.js";

const id = "local-tool-1";

describe("M-3 agent operation schemas", () => {
  it.each([
    { id, op: "fs.read", body: { path: "/workspace/input.txt", range: { start: 0, end: 10 } } },
    { id, op: "fs.write", body: { path: "/workspace/output.txt", content: "value" } },
    {
      id,
      op: "fs.edit",
      body: { path: "/workspace/output.txt", oldString: "value", newString: "updated" },
    },
    {
      id,
      op: "fs.search",
      body: {
        pattern: "updated",
        path: "/workspace",
        opts: { fixedStrings: true, caseSensitive: false },
      },
    },
    {
      id,
      op: "proc.exec",
      body: {
        argv: ["rg", "-n", "updated", "/workspace"],
        cwd: "/workspace",
        timeoutMs: 30_000,
      },
    },
    { id, op: "user.ask", body: { question: "Continue?", options: ["yes", "no"] } },
  ])("accepts $op", (request) => {
    expect(AgentOperationRequestSchema.safeParse(request).success).toBe(true);
  });

  it("rejects empty edit matches, inverted ranges, shell-shaped exec, and unknown fields", () => {
    expect(
      AgentOperationRequestSchema.safeParse({
        id,
        op: "fs.edit",
        body: { path: "/workspace/a", oldString: "", newString: "x" },
      }).success,
    ).toBe(false);
    expect(
      AgentOperationRequestSchema.safeParse({
        id,
        op: "fs.read",
        body: { path: "/workspace/a", range: { start: 2, end: 2 } },
      }).success,
    ).toBe(false);
    expect(
      AgentOperationRequestSchema.safeParse({
        id,
        op: "proc.exec",
        body: { command: "sh -c id" },
      }).success,
    ).toBe(false);
    expect(
      AgentOperationRequestSchema.safeParse({
        id,
        op: "user.ask",
        body: { question: "Continue?", approvalNonce: "guest-supplied" },
      }).success,
    ).toBe(false);
  });

  it("enforces the frame id limit in UTF-8 bytes", () => {
    expect(BrokerFrameIdSchema.safeParse("a".repeat(128)).success).toBe(true);
    expect(BrokerFrameIdSchema.safeParse("é".repeat(64)).success).toBe(true);
    expect(BrokerFrameIdSchema.safeParse(`a${"é".repeat(64)}`).success).toBe(false);
  });

  it("validates the bounded symmetric local response", () => {
    expect(
      AgentOperationResponseSchema.safeParse({
        id,
        ok: true,
        body: {
          result: { content: "value" },
          meta: { actionId: "5c62a23b-dd04-43a6-bbde-5c50ca65ba91", durationMs: 2 },
        },
      }).success,
    ).toBe(true);
  });

  it("accepts only a completion matching its declared outcome", () => {
    expect(
      LocalCompletionRequestSchema.safeParse({
        id,
        op: "local.completed",
        body: {
          actionId: "5c62a23b-dd04-43a6-bbde-5c50ca65ba91",
          outcome: "success",
          result: { content: "value" },
        },
      }).success,
    ).toBe(true);
    expect(
      LocalCompletionRequestSchema.safeParse({
        id,
        op: "local.completed",
        body: {
          actionId: "5c62a23b-dd04-43a6-bbde-5c50ca65ba91",
          outcome: "failure",
          result: { content: "must be rejected" },
        },
      }).success,
    ).toBe(false);
  });
});
