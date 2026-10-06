import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const sessionStatus = pgEnum("session_status", [
  "pending",
  "booting",
  "ready",
  "active",
  "suspended",
  "terminating",
  "terminated",
  "failed",
]);

export const approvalMode = pgEnum("approval_mode", ["auto", "rule", "always"]);

export const policyBundles = pgTable(
  "policy_bundles",
  {
    id: uuid().primaryKey(),
    version: text().notNull(),
    regoSource: text("rego_source").notNull(),
    wasmBlob: bytea("wasm_blob").notNull(),
    sourceHash: text("source_hash").notNull(),
    signature: text(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    notes: text(),
  },
  (table) => [uniqueIndex("policy_bundles_version_uidx").on(table.version)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey(),
    status: sessionStatus().notNull().default("pending"),
    agentImage: text("agent_image").notNull(),
    entrypoint: text().notNull().default("default"),
    approvalMode: approvalMode("approval_mode").notNull().default("rule"),
    scopes: text().array().notNull(),
    roles: text().array().notNull().default(sql`'{}'::text[]`),
    policyBundleId: uuid("policy_bundle_id")
      .notNull()
      .references(() => policyBundles.id),
    requestedBy: text("requested_by").notNull(),
    purpose: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    hostId: text("host_id"),
    driver: text(),
    hardwareIsolated: boolean("hardware_isolated").notNull(),
    snapshotRef: text("snapshot_ref"),
    baseSnapshotId: uuid("base_snapshot_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    idleTimeoutSeconds: integer("idle_timeout_s").notNull().default(300),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    terminationReason: text("termination_reason"),
    nextAuditSeq: integer("next_audit_seq").notNull().default(0),
    actionAllowCount: integer("action_allow_count").notNull().default(0),
    actionDenyCount: integer("action_deny_count").notNull().default(0),
    actionRequireApprovalCount: integer("action_require_approval_count").notNull().default(0),
    failureReason: text("failure_reason"),
  },
  (table) => [
    index("sessions_active_status_idx")
      .on(table.status)
      .where(sql`${table.status} IN ('ready', 'active', 'suspended')`),
    index("sessions_unterminated_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.terminatedAt} IS NULL`),
    index("sessions_requester_created_idx").on(table.requestedBy, table.createdAt.desc()),
  ],
);

export const sessionTokens = pgTable(
  "session_tokens",
  {
    id: uuid().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    scopes: text().array().notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),
  },
  (table) => [
    uniqueIndex("session_tokens_token_hash_uidx").on(table.tokenHash),
    uniqueIndex("session_tokens_session_id_uidx").on(table.sessionId),
  ],
);

export const transportBindings = pgTable(
  "transport_bindings",
  {
    id: uuid().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    hostId: text("host_id").notNull(),
    transportKind: text("transport_kind").notNull(),
    peerIdentifier: text("peer_identifier").notNull(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => sessionTokens.id),
    boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("transport_bindings_active_peer_uidx")
      .on(table.hostId, table.transportKind, table.peerIdentifier)
      .where(sql`${table.releasedAt} IS NULL`),
  ],
);

export const settings = pgTable("settings", {
  key: text().primaryKey(),
  value: jsonb().$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

export const services = pgTable("services", {
  id: uuid().primaryKey(),
  name: text().notNull().unique(),
  adapter: text().notNull(),
  config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean().notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const credentialRefs = pgTable(
  "credential_refs",
  {
    id: uuid().primaryKey(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    role: text().notNull(),
    backend: text().notNull(),
    backendPath: text("backend_path").notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("credential_refs_service_role_uidx").on(table.serviceId, table.role)],
);

export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid().primaryKey(),
    kind: text().notNull(),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    bucket: text().notNull(),
    manifestKey: text("manifest_key").notNull(),
    manifestVersion: text("manifest_version"),
    manifestSha256: text("manifest_sha256").notNull(),
    manifestSizeBytes: bigint("manifest_size_bytes", { mode: "number" }).notNull(),
    manifestKeyId: text("manifest_key_id").notNull(),
    builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    baseSnapshotId: uuid("base_snapshot_id"),
    lineageSessionId: uuid("lineage_session_id").references(() => sessions.id, {
      onDelete: "cascade",
    }),
    resumeAuditSeq: integer("resume_audit_seq"),
    resumeActionId: uuid("resume_action_id"),
    deletionState: text("deletion_state").notNull().default("active"),
  },
  (table) => [index("snapshots_kind_promoted_idx").on(table.kind, table.promotedAt.desc())],
);

export const sessionSnapshotKeys = pgTable("session_snapshot_keys", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  rootKekKeyId: text("root_kek_key_id").notNull(),
  wrapNonce: bytea("wrap_nonce").notNull(),
  wrappedSessionKek: bytea("wrapped_session_kek").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const snapshotKeys = pgTable(
  "snapshot_keys",
  {
    snapshotId: uuid("snapshot_id")
      .primaryKey()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    wrapNonce: bytea("wrap_nonce").notNull(),
    wrappedDek: bytea("wrapped_dek").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("snapshot_keys_session_idx").on(table.sessionId)],
);

export const snapshotDeletionOutbox = pgTable(
  "snapshot_deletion_outbox",
  {
    snapshotId: uuid("snapshot_id")
      .primaryKey()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    bucket: text().notNull(),
    manifestKey: text("manifest_key").notNull(),
    attempts: integer().notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("snapshot_deletion_outbox_pending_idx").on(table.createdAt)],
);

export const auditOutbox = pgTable(
  "audit_outbox",
  {
    id: uuid().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    deliveryState: text("delivery_state").notNull().default("pending"),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("audit_outbox_session_seq_uidx").on(table.sessionId, table.seq),
    index("audit_outbox_pending_session_seq_idx")
      .on(table.sessionId, table.seq)
      .where(sql`${table.deliveryState} = 'pending'`),
  ],
);

export const systemAuditEvents = pgTable(
  "system_audit_events",
  {
    id: uuid().primaryKey(),
    timestamp: timestamp({ withTimezone: true }).notNull().defaultNow(),
    eventType: text("event_type").notNull(),
    inputHash: text("input_hash").notNull(),
    outcome: text().notNull(),
    durationMs: integer("duration_ms").notNull(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    callerConnection: text("caller_connection"),
  },
  (table) => [index("system_audit_events_timestamp_idx").on(table.timestamp.desc())],
);
