import type { AuditOutboxWriter, SystemAuditWriter } from "@caisson/audit";
import type { PolicyBundleLoader } from "@caisson/policy";
import {
  CaissonError,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  DeleteSessionResponseSchema,
  GetSessionResponseSchema,
  SessionIdSchema,
} from "@caisson/protocol";
import {
  getActiveTraceIdentifiers,
  initializeTelemetry,
  runInSpan,
  SPAN_NAMES,
} from "@caisson/telemetry";
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
  readonly audit?: AuditOutboxWriter;
  readonly policyBundles?: PolicyBundleLoader;
  readonly systemAudit?: SystemAuditWriter;
}

export function createControlPlaneServer(options: ControlPlaneServerOptions): FastifyInstance {
  const otlpEndpoint = process.env["CAISSON_OTLP_ENDPOINT"];
  initializeTelemetry(otlpEndpoint === undefined ? {} : { otlpEndpoint });
  const app = Fastify();
  const reconcileIntervalMs = options.reconcileIntervalMs ?? 5_000;
  const reconciler = new PeriodicReconciler(
    {
      reconcile: async () => {
        await options.audit?.drainPending();
        await options.lifecycle.reconcile();
      },
    },
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

  app.post("/v1/policy/simulate", async (request, reply) => {
    const policyBundles = options.policyBundles;
    const systemAudit = options.systemAudit;
    if (policyBundles === undefined || systemAudit === undefined) {
      throw new CaissonError("POLICY_UNAVAILABLE", "policy evaluation is unavailable");
    }
    const input = z.record(z.string(), z.json()).safeParse(request.body);
    if (!input.success) {
      throw new CaissonError("INVALID_REQUEST", "policy simulation input is invalid");
    }
    return runInSpan(SPAN_NAMES.policyEval, async () => {
      const startedAt = performance.now();
      try {
        const bundle = await policyBundles.loadActive();
        const result = bundle.evaluator.evaluate(input.data);
        const trace = getActiveTraceIdentifiers();
        if (trace === undefined) throw new CaissonError("INTERNAL", "policy trace is unavailable");
        await systemAudit.write({
          eventType: "policy.simulate",
          policyInput: input.data,
          outcome: result.decision,
          durationMs: Math.round(performance.now() - startedAt),
          ...trace,
          callerConnection: request.ip,
        });
        return reply.status(200).send(result);
      } catch (error: unknown) {
        if (error instanceof CaissonError && error.code === "AUDIT_UNAVAILABLE") throw error;
        const trace = getActiveTraceIdentifiers();
        if (trace !== undefined) {
          await systemAudit.write({
            eventType: "policy.simulate",
            policyInput: input.data,
            outcome: "error",
            durationMs: Math.round(performance.now() - startedAt),
            ...trace,
            callerConnection: request.ip,
          });
        }
        throw error;
      }
    });
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
