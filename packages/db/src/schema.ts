import { sql } from "drizzle-orm";
import {
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
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    idleTimeoutSeconds: integer("idle_timeout_s").notNull().default(300),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    terminationReason: text("termination_reason"),
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
