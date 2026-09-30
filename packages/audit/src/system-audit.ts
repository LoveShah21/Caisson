import { createHash, randomUUID } from "node:crypto";

import { CaissonError } from "@caisson/protocol";
import type { Sql } from "postgres";

const secretKeys = new Set([
  "password",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "credential",
  "accesskey",
]);

export interface SystemAuditInput {
  readonly eventType: string;
  readonly policyInput: unknown;
  readonly outcome: "allow" | "deny" | "require_approval" | "error";
  readonly durationMs: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly callerConnection?: string;
}

/** Low-volume audit for non-session administrative actions. */
export class SystemAuditWriter {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async write(input: SystemAuditInput): Promise<void> {
    if (containsSecretShape(input.policyInput)) {
      throw new CaissonError(
        "INVALID_REQUEST",
        "policy simulation input contains secret-shaped data",
      );
    }
    const encoded = JSON.stringify(input.policyInput);
    if (encoded === undefined) {
      throw new CaissonError("INVALID_REQUEST", "policy simulation input is not JSON");
    }
    try {
      await this.#sql`
        INSERT INTO system_audit_events (
          id, event_type, input_hash, outcome, duration_ms, trace_id, span_id, caller_connection
        ) VALUES (
          ${randomUUID()}, ${input.eventType},
          ${createHash("sha256").update(encoded).digest("hex")}, ${input.outcome},
          ${input.durationMs}, ${input.traceId}, ${input.spanId}, ${input.callerConnection ?? null}
        )
      `;
    } catch (error: unknown) {
      throw new CaissonError("AUDIT_UNAVAILABLE", "system audit write failed", undefined, error);
    }
  }
}

export function containsSecretShape(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      /AKIA[A-Z0-9]{16}/u.test(value) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value) ||
      /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(value) ||
      /sk-[A-Za-z0-9]{20,}/u.test(value)
    );
  }
  if (Array.isArray(value)) return value.some(containsSecretShape);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      secretKeys.has(key.replace(/[^a-z]/giu, "").toLowerCase()) || containsSecretShape(child),
  );
}
