import { z } from "zod";

import { ErrorCodeSchema } from "./errors.js";

export const SessionIdSchema = z.string().uuid();
export const TraceIdSchema = z.string().min(1).max(128);
export const BrokerFrameIdSchema = z.string().min(1).max(128);
const BrokerErrorMessageSchema = z.string().min(1).max(512);
const BrokerErrorDetailValueSchema = z.union([
  z.string().max(512),
  z.number(),
  z.boolean(),
  z.null(),
]);
const BrokerErrorDetailsSchema = z.record(z.string().min(1).max(128), BrokerErrorDetailValueSchema);
export const ApprovalModeSchema = z.enum(["auto", "rule", "always"]);
export const IsolationDriverNameSchema = z.enum(["firecracker", "container"]);
export const PolicyDecisionSchema = z.enum(["allow", "deny", "require_approval"]);
export const SessionStatusSchema = z.enum([
  "pending",
  "booting",
  "ready",
  "active",
  "suspended",
  "terminating",
  "terminated",
  "failed",
]);

export const TerminalSessionStatusSchema = z.enum(["terminated", "failed"]);
export const SessionFailureReasonSchema = z.enum([
  "start_timeout",
  "driver_error",
  "cleanup_pending",
]);

export const BrokerCallBodySchema = z
  .object({
    service: z.string().min(1),
    method: z.string().min(1),
    params: z.record(z.string(), z.json()),
    idempotencyKey: z.string().min(1),
    intent: z.string().trim().min(1),
  })
  .strict();

export const BrokerCallRequestSchema = z
  .object({
    id: BrokerFrameIdSchema,
    op: z.literal("broker.call"),
    body: BrokerCallBodySchema,
  })
  .strict();

export const BrokerCallResponseSchema = z.union([
  z
    .object({
      id: BrokerFrameIdSchema,
      ok: z.literal(true),
      body: z
        .object({
          result: z.json(),
          meta: z
            .object({
              durationMs: z.number().int().nonnegative(),
              redactionCount: z.number().int().nonnegative(),
              roleUsed: z.string().max(128),
              actionId: SessionIdSchema,
              truncated: z.boolean().optional(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: BrokerFrameIdSchema,
      ok: z.literal(false),
      error: z
        .object({
          code: ErrorCodeSchema,
          message: BrokerErrorMessageSchema,
          details: BrokerErrorDetailsSchema,
          actionId: SessionIdSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const DriverCapabilitiesSchema = z
  .object({
    hardwareIsolation: z.boolean(),
    snapshotSupport: z.boolean(),
    maxConcurrent: z.number().int().positive(),
  })
  .strict();

export const CreateSessionRequestSchema = z
  .object({
    agent: z
      .object({
        image: z.string().min(1),
        entrypoint: z.string().min(1).default("default"),
      })
      .strict(),
    scopes: z.array(z.string().min(1)).min(1),
    approvalMode: ApprovalModeSchema,
    policyBundleId: SessionIdSchema.optional(),
    ttlSeconds: z.number().int().positive(),
    idleTimeoutSeconds: z.number().int().positive(),
    requestedBy: z.string().trim().min(1),
    purpose: z.string().optional(),
    metadata: z.record(z.string(), z.json()).default({}),
  })
  .strict();

export const CreateSessionResponseSchema = z
  .object({
    sessionId: SessionIdSchema,
    status: z.literal("booting"),
    driver: IsolationDriverNameSchema,
    hardwareIsolated: z.boolean(),
    expiresAt: z.string().datetime({ offset: true }),
    websocketUrl: z.string().url(),
  })
  .strict();

export const GetSessionResponseSchema = z
  .object({
    sessionId: SessionIdSchema,
    status: SessionStatusSchema,
    scopes: z.array(z.string()),
    driver: IsolationDriverNameSchema.nullable(),
    hardwareIsolated: z.boolean(),
    intent: z.string().nullable(),
    requestedBy: z.string(),
    policyBundleId: SessionIdSchema,
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    lastActivityAt: z.string().datetime({ offset: true }),
    failureReason: SessionFailureReasonSchema.nullable(),
    actionCounts: z
      .object({
        allow: z.number().int().nonnegative(),
        deny: z.number().int().nonnegative(),
        requireApproval: z.number().int().nonnegative(),
      })
      .strict(),
    pendingApprovals: z.number().int().nonnegative(),
  })
  .strict();

export const DeleteSessionResponseSchema = z
  .object({
    sessionId: SessionIdSchema,
    status: TerminalSessionStatusSchema,
  })
  .strict();

export const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: ErrorCodeSchema,
        message: BrokerErrorMessageSchema,
        details: BrokerErrorDetailsSchema,
        traceId: TraceIdSchema,
      })
      .strict(),
  })
  .strict();

export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type BrokerCallBody = z.infer<typeof BrokerCallBodySchema>;
export type BrokerCallRequest = z.infer<typeof BrokerCallRequestSchema>;
export type BrokerCallResponse = z.infer<typeof BrokerCallResponseSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponseSchema>;
export type DriverCapabilities = z.infer<typeof DriverCapabilitiesSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type IsolationDriverName = z.infer<typeof IsolationDriverNameSchema>;
export type GetSessionResponse = z.infer<typeof GetSessionResponseSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SessionFailureReason = z.infer<typeof SessionFailureReasonSchema>;
export type TerminalSessionStatus = z.infer<typeof TerminalSessionStatusSchema>;
