import { createHash, randomUUID } from "node:crypto";

import type { AuditOutboxWriter } from "@caisson/audit";
import type {
  SessionActionGate,
  SessionIdentityResolver,
  TransportPeer,
} from "@caisson/control-plane";
import type { PolicyBundleLoader } from "@caisson/policy";
import {
  type BrokerCallRequest,
  BrokerCallRequestSchema,
  type BrokerCallResponse,
  BrokerCallResponseSchema,
  CaissonError,
} from "@caisson/protocol";
import type { CredentialRef, Credentials, SecretBackend } from "@caisson/secrets";
import {
  ATTRIBUTE_KEYS,
  getActiveTraceIdentifiers,
  runInSpan,
  SPAN_NAMES,
} from "@caisson/telemetry";
import type { z } from "zod";

export interface BrokerMethod {
  readonly params: z.ZodType;
  readonly scopeRequired: string | ((params: unknown) => string);
  readonly sideEffecting: boolean | ((params: unknown) => boolean);
  readonly summarise: (params: unknown) => string;
  execute(
    credentials: Credentials | undefined,
    params: unknown,
    context: { timeoutMs: number },
  ): Promise<unknown>;
}

export interface BrokerAdapter {
  readonly name: string;
  readonly methods: Readonly<Record<string, BrokerMethod>>;
}

export interface BrokerService {
  readonly adapter: BrokerAdapter;
  readonly timeoutMs: number;
}

export interface BrokerServiceResolver {
  resolveService(service: string): Promise<BrokerService>;
  resolveCredentialRef(service: string, role: string): Promise<CredentialRef | undefined>;
}

export interface BrokerPipelineOptions {
  readonly identities: SessionIdentityResolver;
  readonly services: BrokerServiceResolver;
  readonly policyBundles: PolicyBundleLoader;
  readonly secrets: SecretBackend;
  readonly audit: AuditOutboxWriter;
  readonly actionGate: SessionActionGate;
}

export class BrokerPipeline {
  readonly #identities: SessionIdentityResolver;
  readonly #services: BrokerServiceResolver;
  readonly #policyBundles: PolicyBundleLoader;
  readonly #secrets: SecretBackend;
  readonly #audit: AuditOutboxWriter;
  readonly #actionGate: SessionActionGate;

  constructor(options: BrokerPipelineOptions) {
    this.#identities = options.identities;
    this.#services = options.services;
    this.#policyBundles = options.policyBundles;
    this.#secrets = options.secrets;
    this.#audit = options.audit;
    this.#actionGate = options.actionGate;
  }

  async handle(peer: TransportPeer, frame: unknown): Promise<BrokerCallResponse> {
    const request = BrokerCallRequestSchema.safeParse(frame);
    if (!request.success) {
      throw new CaissonError("PARAMS_INVALID", "invalid broker request");
    }
    return this.#handleRequest(peer, request.data);
  }

  async #handleRequest(
    peer: TransportPeer,
    request: BrokerCallRequest,
  ): Promise<BrokerCallResponse> {
    return runInSpan(SPAN_NAMES.brokerCall, async (span) => {
      const startedAt = performance.now();
      const identity = await this.#identities.resolve(peer);
      const lease = this.#actionGate.enter(identity.sessionId);
      if (lease === undefined) {
        const actionId = randomUUID();
        await this.#audit.persistDurably(
          auditInput({
            identity,
            actionId,
            request,
            eventType: "action.denied",
            decision: "deny",
            policyBundle: identity.policyBundleId,
            policyReason: "session snapshot capture is active",
            scopeUsed: "",
            durationMs: Math.round(performance.now() - startedAt),
            errorCode: "SESSION_SUSPENDED",
            errorMessage: "session snapshot capture is active",
          }),
        );
        return {
          id: request.id,
          ok: false,
          error: {
            code: "SESSION_SUSPENDED",
            message: "session snapshot capture is active",
            details: {},
            actionId,
          },
        };
      }
      try {
        const service = await this.#services.resolveService(request.body.service);
        const method = service.adapter.methods[request.body.method];
        if (method === undefined)
          throw new CaissonError("METHOD_NOT_FOUND", "broker method is unavailable");
        const params = method.params.safeParse(request.body.params);
        if (!params.success) throw new CaissonError("PARAMS_INVALID", "invalid adapter parameters");
        const scopeUsed = resolveValue(method.scopeRequired, params.data);
        const sideEffecting = resolveValue(method.sideEffecting, params.data);
        const actionId = randomUUID();
        span.setAttribute(ATTRIBUTE_KEYS.sessionId, identity.sessionId);
        span.setAttribute(ATTRIBUTE_KEYS.service, service.adapter.name);
        span.setAttribute(ATTRIBUTE_KEYS.method, request.body.method);
        span.setAttribute(ATTRIBUTE_KEYS.actionId, actionId);
        span.setAttribute(ATTRIBUTE_KEYS.scopeUsed, scopeUsed);

        const bundle = await this.#policyBundles.load(identity.policyBundleId);
        const now = new Date();
        const decision = bundle.evaluator.evaluate({
          session: {
            id: identity.sessionId,
            roles: identity.roles,
            scopes: identity.scopes,
            approvalMode: identity.approvalMode,
            expiresAt: identity.expiresAt.toISOString(),
            validAtEvaluation: identity.expiresAt.getTime() > now.getTime(),
            requestedBy: identity.requestedBy,
            purpose: identity.purpose,
          },
          action: {
            service: service.adapter.name,
            method: request.body.method,
            sideEffecting,
            scopeRequired: scopeUsed,
            params: params.data,
          },
          context: {
            now: now.toISOString(),
            hardwareIsolated: identity.hardwareIsolated,
            actionCountThisMethod: 0,
          },
        });
        span.setAttribute(ATTRIBUTE_KEYS.decision, decision.decision);
        const obligationContext = resolveObligations(decision.obligations);
        if (decision.decision !== "allow") {
          await this.#audit.persistDurably(
            auditInput({
              identity,
              actionId,
              request,
              eventType: "action.denied",
              decision: decision.decision,
              policyBundle: bundle.id,
              policyReason: decision.reason,
              obligations: decision.obligations,
              scopeUsed,
              durationMs: Math.round(performance.now() - startedAt),
            }),
          );
          return {
            id: request.id,
            ok: false,
            error: {
              code:
                decision.decision === "require_approval" ? "APPROVAL_REQUIRED" : "POLICY_DENIED",
              message: decision.reason,
              details: { scopeRequired: scopeUsed },
              actionId,
            },
          };
        }

        await this.#audit.persistBeforeExecution(
          auditInput({
            identity,
            actionId,
            request,
            eventType: "action.started",
            decision: "allow",
            policyBundle: bundle.id,
            policyReason: decision.reason,
            obligations: decision.obligations,
            scopeUsed,
          }),
        );
        try {
          const credentialRef = await this.#services.resolveCredentialRef(
            request.body.service,
            obligationContext.role,
          );
          const credentials =
            credentialRef === undefined ? undefined : await this.#secrets.fetch(credentialRef);
          const result = await method.execute(credentials, params.data, {
            timeoutMs: service.timeoutMs,
          });
          const encoded = JSON.stringify(result);
          await this.#audit.persistDurably(
            auditInput({
              identity,
              actionId,
              request,
              eventType: "action.completed",
              decision: "allow",
              policyBundle: bundle.id,
              policyReason: decision.reason,
              obligations: decision.obligations,
              scopeUsed,
              durationMs: Math.round(performance.now() - startedAt),
              resultBytes: Buffer.byteLength(encoded),
              resultHash: sha256(encoded),
            }),
          );
          return BrokerCallResponseSchema.parse({
            id: request.id,
            ok: true,
            body: {
              result: JSON.parse(encoded),
              meta: {
                durationMs: Math.round(performance.now() - startedAt),
                redactionCount: 0,
                roleUsed: obligationContext.role,
                actionId,
                truncated: resultIsTruncated(result),
              },
            },
          });
        } catch (error: unknown) {
          const caisson =
            error instanceof CaissonError
              ? error
              : new CaissonError("SERVICE_ERROR", "service call failed", undefined, error);
          await this.#audit.persistDurably(
            auditInput({
              identity,
              actionId,
              request,
              eventType: "action.failed",
              decision: "allow",
              policyBundle: bundle.id,
              policyReason: decision.reason,
              obligations: decision.obligations,
              scopeUsed,
              durationMs: Math.round(performance.now() - startedAt),
              errorCode: caisson.code,
              errorMessage: caisson.message,
            }),
          );
          return {
            id: request.id,
            ok: false,
            error: {
              code: caisson.code,
              message: caisson.message.slice(0, 512),
              details: {},
              actionId,
            },
          };
        }
      } finally {
        lease.release();
      }
    });
  }
}

function resolveValue<T>(value: T | ((params: unknown) => T), params: unknown): T {
  if (typeof value === "function") {
    return (value as (input: unknown) => T)(params);
  }
  return value;
}

function auditInput(input: {
  identity: Awaited<ReturnType<SessionIdentityResolver["resolve"]>>;
  actionId: string;
  request: BrokerCallRequest;
  eventType: string;
  decision: string;
  policyBundle: string;
  policyReason: string;
  obligations?: readonly string[];
  scopeUsed: string;
  durationMs?: number;
  resultBytes?: number;
  resultHash?: string;
  errorCode?: string;
  errorMessage?: string;
}) {
  const trace = getActiveTraceIdentifiers();
  return {
    sessionId: input.identity.sessionId,
    actionId: input.actionId,
    eventType: input.eventType,
    actionType: "broker_call",
    service: input.request.body.service,
    method: input.request.body.method,
    decision: input.decision,
    policyBundle: input.policyBundle,
    policyReason: input.policyReason,
    obligations: input.obligations ?? [],
    scopeUsed: input.scopeUsed,
    paramsHash: sha256(JSON.stringify(input.request.body.params)),
    paramsPreview: "",
    agentIntent: input.request.body.intent,
    driver: input.identity.driver,
    hardwareIsolated: input.identity.hardwareIsolated,
    redactionCount: 0,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.resultBytes === undefined ? {} : { resultBytes: input.resultBytes }),
    ...(input.resultHash === undefined ? {} : { resultHash: input.resultHash }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    ...(trace === undefined ? {} : trace),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveObligations(obligations: readonly string[]): { readonly role: string } {
  let role = "default";
  for (const obligation of obligations) {
    const roleMatch = /^role:([a-z][a-z0-9_-]{0,127})$/iu.exec(obligation);
    if (roleMatch !== null) {
      role = roleMatch[1]!;
      continue;
    }
    // An obligation is a security constraint. Until a matching enforcement
    // mechanism exists, accepting it would silently widen policy intent.
    throw new CaissonError("POLICY_UNAVAILABLE", "policy obligation cannot be honored");
  }
  return { role };
}

function resultIsTruncated(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "truncated" in value &&
    (value as { truncated?: unknown }).truncated === true
  );
}
