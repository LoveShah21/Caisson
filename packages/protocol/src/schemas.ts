import { z } from "zod";

import { ErrorCodeSchema } from "./errors.js";

export const SessionIdSchema = z.string().uuid();
export const TraceIdSchema = z.string().min(1).max(128);
export const BrokerFrameIdSchema = z
  .string()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 128, {
    message: "frame id exceeds 128 UTF-8 bytes",
  });
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

export const WorkspacePathSchema = z.string().min(1).max(4096);
const WorkspaceContentSchema = z.string().max(2 * 1024 * 1024);
const WorkspaceMatchSchema = z
  .string()
  .min(1)
  .max(2 * 1024 * 1024);
const ToolRequestBaseSchema = z.object({ id: BrokerFrameIdSchema });

export const FsReadRequestSchema = ToolRequestBaseSchema.extend({
  op: z.literal("fs.read"),
  body: z
    .object({
      path: WorkspacePathSchema,
      range: z
        .object({
          start: z.number().int().nonnegative(),
          end: z.number().int().positive(),
        })
        .strict()
        .refine((range) => range.end > range.start, "range end must exceed start")
        .optional(),
    })
    .strict(),
}).strict();

export const FsWriteRequestSchema = ToolRequestBaseSchema.extend({
  op: z.literal("fs.write"),
  body: z.object({ path: WorkspacePathSchema, content: WorkspaceContentSchema }).strict(),
}).strict();

export const FsEditRequestSchema = ToolRequestBaseSchema.extend({
  op: z.literal("fs.edit"),
  body: z
    .object({
      path: WorkspacePathSchema,
      oldString: WorkspaceMatchSchema,
      newString: WorkspaceContentSchema,
    })
    .strict(),
}).strict();

export const FsSearchRequestSchema = ToolRequestBaseSchema.extend({
  op: z.literal("fs.search"),
  body: z
    .object({
      pattern: z.string().min(1).max(4096),
      path: WorkspacePathSchema.optional(),
      opts: z
        .object({
          fixedStrings: z.boolean().optional(),
          caseSensitive: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
}).strict();

export const ProcExecRequestSchema = ToolRequestBaseSchema.extend({
  op: z.literal("proc.exec"),
  body: z
    .object({
      argv: z.array(z.string().min(1).max(8192)).min(1).max(128),
      cwd: WorkspacePathSchema.optional(),
      timeoutMs: z.number().int().positive().max(300_000).optional(),
    })
    .strict(),
}).strict();

export const UserAskRequestSchema = ToolRequestBaseSchema.extend({
  op: z.literal("user.ask"),
  body: z
    .object({
      question: z.string().trim().min(1).max(8192),
      options: z.array(z.string().trim().min(1).max(1024)).min(1).max(20).optional(),
    })
    .strict(),
}).strict();

export const LocalToolRequestSchema = z.union([
  FsReadRequestSchema,
  FsWriteRequestSchema,
  FsEditRequestSchema,
  FsSearchRequestSchema,
  ProcExecRequestSchema,
  UserAskRequestSchema,
]);

export const LocalAuthorizedResponseSchema = z
  .object({
    id: BrokerFrameIdSchema,
    ok: z.literal(true),
    body: z
      .object({
        actionId: SessionIdSchema,
        authorized: z.literal(true),
      })
      .strict(),
  })
  .strict();

const LocalCompletionErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    message: BrokerErrorMessageSchema,
    details: BrokerErrorDetailsSchema,
  })
  .strict();

export const LocalCompletionRequestSchema = z
  .object({
    id: BrokerFrameIdSchema,
    op: z.literal("local.completed"),
    body: z
      .union([
        z
          .object({
            actionId: SessionIdSchema,
            outcome: z.literal("success"),
            result: z.json(),
          })
          .strict(),
        z
          .object({
            actionId: SessionIdSchema,
            outcome: z.literal("failure"),
            error: LocalCompletionErrorSchema,
          })
          .strict(),
      ])
      .refine(
        (body) =>
          (body.outcome === "success" && "result" in body) ||
          (body.outcome === "failure" && "error" in body),
        "local completion does not match its outcome",
      ),
  })
  .strict();

export const AgentOperationRequestSchema = z.union([
  BrokerCallRequestSchema,
  LocalToolRequestSchema,
]);

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

export const LocalToolResponseSchema = z.union([
  z
    .object({
      id: BrokerFrameIdSchema,
      ok: z.literal(true),
      body: z
        .object({
          result: z.json(),
          meta: z
            .object({
              actionId: SessionIdSchema,
              durationMs: z.number().int().nonnegative(),
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

export const AgentOperationResponseSchema = z.union([
  BrokerCallResponseSchema,
  LocalToolResponseSchema,
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
export type AgentOperationRequest = z.infer<typeof AgentOperationRequestSchema>;
export type AgentOperationResponse = z.infer<typeof AgentOperationResponseSchema>;
export type LocalToolRequest = z.infer<typeof LocalToolRequestSchema>;
export type LocalToolResponse = z.infer<typeof LocalToolResponseSchema>;
export type LocalAuthorizedResponse = z.infer<typeof LocalAuthorizedResponseSchema>;
export type LocalCompletionRequest = z.infer<typeof LocalCompletionRequestSchema>;
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
