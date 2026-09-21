import { z } from "zod";

import { ErrorCodeSchema } from "./errors.js";

export const SessionIdSchema = z.string().uuid();
export const TraceIdSchema = z.string().min(1);
export const ApprovalModeSchema = z.enum(["auto", "rule", "always"]);
export const IsolationDriverNameSchema = z.enum(["firecracker", "container"]);
export const PolicyDecisionSchema = z.enum(["allow", "deny", "require_approval"]);

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
    ttlSeconds: z.number().int().positive(),
    idleTimeoutSeconds: z.number().int().positive(),
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

export const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: ErrorCodeSchema,
        message: z.string(),
        details: z.record(z.string(), z.unknown()),
        traceId: TraceIdSchema,
      })
      .strict(),
  })
  .strict();

export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type DriverCapabilities = z.infer<typeof DriverCapabilitiesSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type IsolationDriverName = z.infer<typeof IsolationDriverNameSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
