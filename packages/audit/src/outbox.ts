import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { CaissonError } from "@caisson/protocol";
import type { Sql, TransactionSql } from "postgres";

const PREVIEW_MAX_BYTES = 512;
const EMPTY_HASH = "0".repeat(64);

export interface AuditEventInput {
  readonly sessionId: string;
  readonly actionId: string;
  readonly timestamp?: Date;
  readonly eventType: string;
  readonly actionType: string;
  readonly service?: string;
  readonly method?: string;
  readonly decision?: string;
  readonly policyBundle?: string;
  readonly policyReason?: string;
  readonly obligations?: readonly string[];
  readonly scopeUsed?: string;
  readonly roleUsed?: string;
  readonly paramsHash?: string;
  readonly paramsPreview?: string;
  readonly resultBytes?: number;
  readonly resultHash?: string;
  readonly redactionCount?: number;
  readonly durationMs?: number;
  readonly approvalId?: string | null;
  readonly approvalWaitMs?: number | null;
  readonly skillLoaded?: string;
  readonly agentIntent?: string;
  readonly driver: "container" | "firecracker";
  readonly hardwareIsolated: boolean;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly networkDestination?: string;
  readonly networkProtocol?: string;
}

export interface StoredAuditEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly payload: AuditPayload;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface AuditPayload extends Readonly<Record<string, JsonValue>> {
  readonly actionId: string;
  readonly timestamp: string;
  readonly eventType: string;
  readonly actionType: string;
  readonly service: string;
  readonly method: string;
  readonly decision: string;
  readonly policyBundle: string;
  readonly policyReason: string;
  readonly obligations: readonly string[];
  readonly scopeUsed: string;
  readonly roleUsed: string;
  readonly paramsHash: string;
  readonly paramsPreview: string;
  readonly resultBytes: number;
  readonly resultHash: string;
  readonly redactionCount: number;
  readonly durationMs: number;
  readonly approvalId: string | null;
  readonly approvalWaitMs: number | null;
  readonly skillLoaded: string;
  readonly agentIntent: string;
  readonly driver: "container" | "firecracker";
  readonly hardwareIsolated: boolean;
  readonly traceId: string;
  readonly spanId: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly networkDestination: string;
  readonly networkProtocol: string;
}

interface OutboxRow {
  readonly id: string;
  readonly session_id: string;
  readonly seq: number;
  readonly payload: AuditPayload;
}

export interface AuditSink {
  hasEvent(sessionId: string, seq: number): Promise<boolean>;
  insert(event: StoredAuditEvent): Promise<void>;
}

export class AuditOutboxWriter {
  readonly #sql: Sql;
  readonly #sink: AuditSink;

  constructor(sql: Sql, sink: AuditSink) {
    this.#sql = sql;
    this.#sink = sink;
  }

  async enqueue(input: AuditEventInput): Promise<StoredAuditEvent> {
    const payload = buildAuditPayload(input);
    return this.#sql.begin(async (transaction) => {
      return allocateOutboxEvent(transaction, input, payload);
    });
  }

  async enqueueInTransaction(
    transaction: Sql | TransactionSql,
    input: AuditEventInput,
  ): Promise<StoredAuditEvent> {
    return allocateOutboxEvent(transaction, input, buildAuditPayload(input));
  }

  async persistBeforeExecution(input: AuditEventInput): Promise<StoredAuditEvent> {
    const event = await this.enqueue(input);
    await this.deliverSession(event.sessionId);
    return event;
  }

  async persistDurably(input: AuditEventInput): Promise<StoredAuditEvent> {
    return this.enqueue(input);
  }

  async deliverSession(sessionId: string): Promise<void> {
    let activeEventId: string | undefined;
    try {
      await this.#sql.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}, 0))`;
        const rows = await transaction<OutboxRow[]>`
          SELECT id, session_id, seq, payload
          FROM audit_outbox
          WHERE session_id = ${sessionId} AND delivery_state = 'pending'
          ORDER BY seq
          FOR UPDATE
        `;

        for (const row of rows) {
          activeEventId = row.id;
          const event: StoredAuditEvent = {
            id: row.id,
            sessionId: row.session_id,
            seq: row.seq,
            payload: row.payload,
          };
          if (!(await this.#sink.hasEvent(event.sessionId, event.seq))) {
            await this.#sink.insert(event);
          }
          await transaction`
            UPDATE audit_outbox
            SET delivery_state = 'delivered', delivered_at = now(),
                delivery_attempts = delivery_attempts + 1, last_error = NULL
            WHERE id = ${event.id}
          `;
        }
      });
    } catch (error: unknown) {
      if (activeEventId !== undefined) {
        await this.#sql`
          UPDATE audit_outbox
          SET delivery_attempts = delivery_attempts + 1, last_error = 'clickhouse delivery failed'
          WHERE id = ${activeEventId}
        `;
      }
      throw new CaissonError("AUDIT_UNAVAILABLE", "audit delivery failed", undefined, error);
    }
  }
}

async function allocateOutboxEvent(
  transaction: Sql | TransactionSql,
  input: AuditEventInput,
  payload: AuditPayload,
): Promise<StoredAuditEvent> {
  const [session] = await transaction<{ next_audit_seq: number }[]>`
    UPDATE sessions
    SET
      next_audit_seq = next_audit_seq + 1,
      action_allow_count = action_allow_count + ${input.decision === "allow" ? 1 : 0},
      action_deny_count = action_deny_count + ${input.decision === "deny" ? 1 : 0},
      action_require_approval_count = action_require_approval_count + ${
        input.decision === "require_approval" ? 1 : 0
      }
    WHERE id = ${input.sessionId}
    RETURNING next_audit_seq
  `;
  if (session === undefined) {
    throw new CaissonError("SESSION_NOT_FOUND", "cannot audit an unknown session");
  }

  const event: StoredAuditEvent = {
    id: uuidV7(),
    sessionId: input.sessionId,
    seq: session.next_audit_seq,
    payload,
  };
  await transaction`
    INSERT INTO audit_outbox (id, session_id, seq, payload)
    VALUES (${event.id}, ${event.sessionId}, ${event.seq}, ${transaction.json(event.payload)}::jsonb)
  `;
  return event;
}

export interface ClickHouseAuditOptions {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly database?: string;
}

export class ClickHouseAuditSink implements AuditSink {
  readonly #url: string;
  readonly #authorization: string;
  readonly #database: string;

  constructor(options: ClickHouseAuditOptions) {
    this.#url = options.url.replace(/\/$/, "");
    this.#authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
    this.#database = options.database ?? "caisson";
  }

  async ensureSchema(): Promise<void> {
    const schema = await readFile(new URL("../sql/actions.sql", import.meta.url), "utf8");
    await this.#query(schema);
  }

  async hasEvent(sessionId: string, seq: number): Promise<boolean> {
    assertSessionAndSeq(sessionId, seq);
    const response = await this.#query(
      `SELECT count() FROM actions WHERE session_id = '${sessionId}' AND seq = ${seq} FORMAT TabSeparated`,
    );
    return Number.parseInt(response.trim(), 10) > 0;
  }

  async insert(event: StoredAuditEvent): Promise<void> {
    assertSessionAndSeq(event.sessionId, event.seq);
    const row = {
      session_id: event.sessionId,
      action_id: event.payload.actionId,
      timestamp: event.payload.timestamp,
      seq: event.seq,
      event_type: event.payload.eventType,
      action_type: event.payload.actionType,
      service: event.payload.service,
      method: event.payload.method,
      decision: event.payload.decision,
      policy_bundle: event.payload.policyBundle,
      policy_reason: event.payload.policyReason,
      obligations: event.payload.obligations,
      scope_used: event.payload.scopeUsed,
      role_used: event.payload.roleUsed,
      params_hash: event.payload.paramsHash,
      params_preview: event.payload.paramsPreview,
      result_bytes: event.payload.resultBytes,
      result_hash: event.payload.resultHash,
      redaction_count: event.payload.redactionCount,
      duration_ms: event.payload.durationMs,
      approval_id: event.payload.approvalId,
      approval_wait_ms: event.payload.approvalWaitMs,
      skill_loaded: event.payload.skillLoaded,
      agent_intent: event.payload.agentIntent,
      driver: event.payload.driver,
      hardware_isolated: event.payload.hardwareIsolated ? 1 : 0,
      trace_id: event.payload.traceId,
      span_id: event.payload.spanId,
      error_code: event.payload.errorCode,
      error_message: event.payload.errorMessage,
      network_destination: event.payload.networkDestination,
      network_protocol: event.payload.networkProtocol,
    };
    await this.#query(`INSERT INTO actions FORMAT JSONEachRow\n${JSON.stringify(row)}`);
  }

  async #query(query: string): Promise<string> {
    const response = await fetch(`${this.#url}/?database=${encodeURIComponent(this.#database)}`, {
      method: "POST",
      headers: { authorization: this.#authorization },
      body: query,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`ClickHouse request failed with status ${response.status}: ${body}`);
    }
    return body;
  }
}

export function buildAuditPayload(input: AuditEventInput): AuditPayload {
  const payload: AuditPayload = {
    actionId: input.actionId,
    timestamp: (input.timestamp ?? new Date()).toISOString(),
    eventType: input.eventType,
    actionType: input.actionType,
    service: input.service ?? "",
    method: input.method ?? "",
    decision: input.decision ?? "n/a",
    policyBundle: input.policyBundle ?? "",
    policyReason: input.policyReason ?? "",
    obligations: input.obligations ?? [],
    scopeUsed: input.scopeUsed ?? "",
    roleUsed: input.roleUsed ?? "",
    paramsHash: input.paramsHash ?? EMPTY_HASH,
    paramsPreview: truncateUtf8(input.paramsPreview ?? "", PREVIEW_MAX_BYTES),
    resultBytes: input.resultBytes ?? 0,
    resultHash: input.resultHash ?? EMPTY_HASH,
    redactionCount: input.redactionCount ?? 0,
    durationMs: input.durationMs ?? 0,
    approvalId: input.approvalId ?? null,
    approvalWaitMs: input.approvalWaitMs ?? null,
    skillLoaded: input.skillLoaded ?? "",
    agentIntent: truncateUtf8(input.agentIntent ?? "", PREVIEW_MAX_BYTES),
    driver: input.driver,
    hardwareIsolated: input.hardwareIsolated,
    traceId: input.traceId ?? "",
    spanId: input.spanId ?? "",
    errorCode: input.errorCode ?? "",
    errorMessage: input.errorMessage ?? "",
    networkDestination: input.networkDestination ?? "",
    networkProtocol: input.networkProtocol ?? "",
  };
  assertSafePayload(payload);
  return payload;
}

function assertSafePayload(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertSafePayload(item);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
    if (
      normalized === "params" ||
      normalized === "rawparams" ||
      normalized === "credential" ||
      normalized === "credentials" ||
      normalized === "secret" ||
      normalized === "secrets" ||
      normalized === "result" ||
      normalized === "rawresult"
    ) {
      throw new CaissonError("AUDIT_UNAVAILABLE", `unsafe audit payload field: ${key}`);
    }
    assertSafePayload(item);
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return value;
  }
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maximumBytes) {
      return result;
    }
    result += character;
  }
  return result;
}

function assertSessionAndSeq(sessionId: string, seq: number): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error("invalid audit session id");
  }
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error("invalid audit sequence");
  }
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
