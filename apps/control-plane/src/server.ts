import {
  CaissonError,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  DeleteSessionResponseSchema,
  GetSessionResponseSchema,
  SessionIdSchema,
} from "@caisson/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import { PeriodicReconciler, type ReconciliationScheduler } from "./periodic-reconciler.js";
import type { SessionLifecycleService } from "./session-lifecycle.js";

const DeleteSessionRequestSchema = z.object({ reason: z.string().trim().min(1) }).strict();
const SessionRouteParamsSchema = z.object({ id: z.unknown() }).strict();

export interface ControlPlaneServerOptions {
  readonly lifecycle: SessionLifecycleService;
  readonly reconcileIntervalMs?: number;
  readonly reconciliationScheduler?: ReconciliationScheduler;
}

export function createControlPlaneServer(options: ControlPlaneServerOptions): FastifyInstance {
  const app = Fastify();
  const reconcileIntervalMs = options.reconcileIntervalMs ?? 5_000;
  const reconciler = new PeriodicReconciler(
    options.lifecycle,
    reconcileIntervalMs,
    options.reconciliationScheduler,
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof CaissonError) {
      void reply.status(statusFor(error.code)).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details ?? {},
          traceId: request.id,
        },
      });
      return;
    }
    void reply.status(500).send({
      error: {
        code: "INTERNAL",
        message: "internal server error",
        details: {},
        traceId: request.id,
      },
    });
  });

  app.post("/v1/sessions", async (request, reply) => {
    const parsed = CreateSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new CaissonError("INVALID_REQUEST", "invalid session creation request");
    }
    const created = await options.lifecycle.create(parsed.data);
    return reply.status(201).send(CreateSessionResponseSchema.parse(created));
  });

  app.get("/v1/sessions/:id", async (request, reply) => {
    const route = SessionRouteParamsSchema.safeParse(request.params);
    if (!route.success) {
      throw new CaissonError("INVALID_REQUEST", "invalid session id");
    }
    const sessionId = SessionIdSchema.safeParse(route.data.id);
    if (!sessionId.success) throw new CaissonError("INVALID_REQUEST", "invalid session id");
    const session = await options.lifecycle.get(sessionId.data);
    return reply.status(200).send(GetSessionResponseSchema.parse(session));
  });

  app.delete("/v1/sessions/:id", async (request, reply) => {
    const route = SessionRouteParamsSchema.safeParse(request.params);
    if (!route.success) throw new CaissonError("INVALID_REQUEST", "invalid session id");
    const sessionId = SessionIdSchema.safeParse(route.data.id);
    const body = DeleteSessionRequestSchema.safeParse(request.body);
    if (!sessionId.success || !body.success) {
      throw new CaissonError("INVALID_REQUEST", "invalid session termination request");
    }
    const destroyed = await options.lifecycle.destroy(sessionId.data, body.data.reason);
    return reply.status(202).send(DeleteSessionResponseSchema.parse(destroyed));
  });

  app.addHook("onReady", async () => {
    await reconciler.start();
  });
  app.addHook("onClose", async () => {
    await reconciler.stop();
  });

  return app;
}

function statusFor(code: CaissonError["code"]): number {
  if (code === "SESSION_NOT_FOUND") {
    return 404;
  }
  if (code === "INVALID_REQUEST" || code === "PARAMS_INVALID") {
    return 400;
  }
  if (code === "AUDIT_UNAVAILABLE" || code === "POLICY_UNAVAILABLE") {
    return 503;
  }
  return 500;
}
