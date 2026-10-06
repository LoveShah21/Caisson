import { createHash, randomUUID } from "node:crypto";

import { type AuditOutboxWriter, containsSecretShape } from "@caisson/audit";
import type {
  SessionActionGate,
  SessionActionLease,
  SessionIdentityResolver,
  TransportPeer,
} from "@caisson/control-plane";
import type { PolicyBundleLoader } from "@caisson/policy";
import {
  CaissonError,
  type LocalAuthorizedResponse,
  LocalAuthorizedResponseSchema,
  type LocalCompletionRequest,
  type LocalToolRequest,
  type LocalToolResponse,
  LocalToolResponseSchema,
} from "@caisson/protocol";
import { getActiveTraceIdentifiers, runInSpan, SPAN_NAMES } from "@caisson/telemetry";

const EXECUTABLES = new Set([
  "rg",
  "jq",
  "git",
  "node",
  "python3",
  "cat",
  "ls",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "diff",
]);
const GIT_SUBCOMMANDS = new Set(["fetch", "clone", "log", "diff", "status"]);

type Identity = Awaited<ReturnType<SessionIdentityResolver["resolve"]>>;

export interface LocalToolPipelineOptions {
  readonly identities: SessionIdentityResolver;
  readonly policyBundles: PolicyBundleLoader;
  readonly audit: AuditOutboxWriter;
  readonly actionGate: SessionActionGate;
  readonly resultMaxBytes: number;
  readonly previewMaxBytes: number;
}

export interface LocalToolAuthorization {
  readonly id: string;
  readonly actionId: string;
  readonly identity: Identity;
  readonly request: LocalToolRequest;
  readonly policyBundleId: string;
  readonly policyReason: string;
  readonly scopeUsed: string;
  readonly startedAt: number;
  readonly lease: SessionActionLease;
}

/** Host-side authorization and audit state for guest-local tools. */
export class LocalToolPipeline {
  readonly #identities: SessionIdentityResolver;
  readonly #policyBundles: PolicyBundleLoader;
  readonly #audit: AuditOutboxWriter;
  readonly #actionGate: SessionActionGate;
  readonly #resultMaxBytes: number;
  readonly #previewMaxBytes: number;

  constructor(options: LocalToolPipelineOptions) {
    assertPositive(options.resultMaxBytes, "local tool result cap");
    assertPositive(options.previewMaxBytes, "local tool audit preview cap");
    this.#identities = options.identities;
    this.#policyBundles = options.policyBundles;
    this.#audit = options.audit;
    this.#actionGate = options.actionGate;
    this.#resultMaxBytes = options.resultMaxBytes;
    this.#previewMaxBytes = options.previewMaxBytes;
  }

  async authorize(peer: TransportPeer, request: LocalToolRequest): Promise<LocalToolAuthorization> {
    return runInSpan(SPAN_NAMES.brokerCall, async () => {
      const startedAt = performance.now();
      const identity = await this.#identities.resolve(peer);
      const scopeUsed = scopeFor(request.op);
      const actionId = randomUUID();
      const lease = this.#actionGate.enter(identity.sessionId);
      if (lease === undefined) {
        const error = new CaissonError("SESSION_SUSPENDED", "session snapshot capture is active", {
          actionId,
        });
        await this.#audit.persistDurably(
          auditEvent({
            identity,
            actionId,
            request,
            eventType: "action.denied",
            decision: "deny",
            policyBundleId: identity.policyBundleId,
            policyReason: error.message,
            scopeUsed,
            durationMs: elapsed(startedAt),
            errorCode: error.code,
            errorMessage: error.message,
          }),
        );
        throw error;
      }
      try {
        const bundle = await this.#policyBundles.load(identity.policyBundleId);
        if (request.op === "proc.exec") {
          try {
            assertAllowedExec(request.body.argv);
          } catch (error) {
            const caisson = asCaissonError(error);
            await this.#audit.persistDurably(
              auditEvent({
                identity,
                actionId,
                request,
                eventType: "action.denied",
                decision: "deny",
                policyBundleId: bundle.id,
                policyReason: caisson.message,
                scopeUsed,
                durationMs: elapsed(startedAt),
                errorCode: caisson.code,
                errorMessage: caisson.message,
              }),
            );
            throw caisson;
          }
        }
        const decision = bundle.evaluator.evaluate({
          session: {
            id: identity.sessionId,
            roles: identity.roles,
            scopes: identity.scopes,
            approvalMode: identity.approvalMode,
            expiresAt: identity.expiresAt.toISOString(),
            requestedBy: identity.requestedBy,
            purpose: identity.purpose,
          },
          action: {
            service: "guest",
            method: request.op,
            sideEffecting:
              request.op === "fs.write" || request.op === "fs.edit" || request.op === "proc.exec",
            scopeRequired: scopeUsed,
            params: request.body,
          },
          context: { now: new Date().toISOString(), hardwareIsolated: identity.hardwareIsolated },
        });
        if (decision.decision !== "allow") {
          await this.#audit.persistDurably(
            auditEvent({
              identity,
              actionId,
              request,
              eventType: "action.denied",
              decision: decision.decision,
              policyBundleId: bundle.id,
              policyReason: decision.reason,
              scopeUsed,
              durationMs: elapsed(startedAt),
            }),
          );
          throw new CaissonError(
            decision.decision === "require_approval" ? "APPROVAL_REQUIRED" : "POLICY_DENIED",
            decision.reason,
            { scopeRequired: scopeUsed, actionId },
          );
        }
        await this.#audit.persistBeforeExecution(
          auditEvent({
            identity,
            actionId,
            request,
            eventType: "action.started",
            decision: "allow",
            policyBundleId: bundle.id,
            policyReason: decision.reason,
            scopeUsed,
          }),
        );
        return {
          id: request.id,
          actionId,
          identity,
          request,
          policyBundleId: bundle.id,
          policyReason: decision.reason,
          scopeUsed,
          startedAt,
          lease,
        };
      } catch (error: unknown) {
        lease.release();
        throw error;
      }
    });
  }

  authorized(authorization: LocalToolAuthorization): LocalAuthorizedResponse {
    return LocalAuthorizedResponseSchema.parse({
      id: authorization.id,
      ok: true,
      body: { actionId: authorization.actionId, authorized: true },
    });
  }

  async complete(
    authorization: LocalToolAuthorization,
    completion: LocalCompletionRequest,
  ): Promise<LocalToolResponse> {
    try {
      if (
        completion.id !== authorization.id ||
        completion.body.actionId !== authorization.actionId
      ) {
        return this.invalidCompletion(authorization, "completion id does not match authorization");
      }
      if (completion.body.outcome === "failure") {
        await this.#audit.persistDurably(
          auditEvent({
            identity: authorization.identity,
            actionId: authorization.actionId,
            request: authorization.request,
            eventType: "action.failed",
            decision: "allow",
            policyBundleId: authorization.policyBundleId,
            policyReason: authorization.policyReason,
            scopeUsed: authorization.scopeUsed,
            durationMs: elapsed(authorization.startedAt),
            errorCode: completion.body.error.code,
            errorMessage: auditSafeErrorMessage(completion.body.error.message),
          }),
        );
        return LocalToolResponseSchema.parse({
          id: authorization.id,
          ok: false,
          error: { ...completion.body.error, actionId: authorization.actionId },
        });
      }

      const encoded = JSON.stringify(completion.body.result);
      const resultBytes = Buffer.byteLength(encoded, "utf8");
      const auditPreview = previewFor(completion.body.result, this.#previewMaxBytes);
      const truncated = resultBytes > this.#resultMaxBytes;
      // The result is guest-authored. Its full byte count and hash remain auditable,
      // while the guest receives only a host-derived bounded representation.
      const responseResult = truncated
        ? {
            truncated: true,
            preview: previewFor(completion.body.result, this.#resultMaxBytes).value,
          }
        : completion.body.result;
      await this.#audit.persistDurably(
        auditEvent({
          identity: authorization.identity,
          actionId: authorization.actionId,
          request: authorization.request,
          eventType: "action.completed",
          decision: "allow",
          policyBundleId: authorization.policyBundleId,
          policyReason: authorization.policyReason,
          scopeUsed: authorization.scopeUsed,
          durationMs: elapsed(authorization.startedAt),
          resultBytes,
          resultHash: sha256(encoded),
          paramsPreview: auditPreview.value,
          redactionCount: auditPreview.redactionCount,
        }),
      );
      return LocalToolResponseSchema.parse({
        id: authorization.id,
        ok: true,
        body: {
          result: responseResult,
          meta: {
            actionId: authorization.actionId,
            durationMs: elapsed(authorization.startedAt),
            ...(truncated ? { truncated: true } : {}),
          },
        },
      });
    } finally {
      authorization.lease.release();
    }
  }

  async abandon(authorization: LocalToolAuthorization, reason: string): Promise<void> {
    try {
      await this.#audit.persistDurably(
        auditEvent({
          identity: authorization.identity,
          actionId: authorization.actionId,
          request: authorization.request,
          eventType: "action.abandoned",
          decision: "allow",
          policyBundleId: authorization.policyBundleId,
          policyReason: authorization.policyReason,
          scopeUsed: authorization.scopeUsed,
          durationMs: elapsed(authorization.startedAt),
          errorCode: "SANDBOX_FAILED",
          errorMessage: reason,
        }),
      );
    } finally {
      authorization.lease.release();
    }
  }

  async invalidCompletion(
    authorization: LocalToolAuthorization,
    reason: string,
  ): Promise<LocalToolResponse> {
    try {
      await this.#audit.persistDurably(
        auditEvent({
          identity: authorization.identity,
          actionId: authorization.actionId,
          request: authorization.request,
          eventType: "action.invalid_completion",
          decision: "allow",
          policyBundleId: authorization.policyBundleId,
          policyReason: authorization.policyReason,
          scopeUsed: authorization.scopeUsed,
          durationMs: elapsed(authorization.startedAt),
          errorCode: "PARAMS_INVALID",
          errorMessage: reason,
        }),
      );
      return LocalToolResponseSchema.parse({
        id: authorization.id,
        ok: false,
        error: {
          code: "PARAMS_INVALID",
          message: "invalid local tool completion",
          details: {},
          actionId: authorization.actionId,
        },
      });
    } finally {
      authorization.lease.release();
    }
  }
}

function scopeFor(operation: LocalToolRequest["op"]): string {
  switch (operation) {
    case "fs.read":
    case "fs.search":
      return "workspace.read";
    case "fs.write":
    case "fs.edit":
      return "workspace.write";
    case "proc.exec":
      return "process.exec";
    case "user.ask":
      return "user.ask";
  }
}

function assertAllowedExec(argv: readonly string[]): void {
  const command = argv[0];
  if (command === undefined || !EXECUTABLES.has(command) || command.includes("/")) {
    throw new CaissonError("BINARY_NOT_ALLOWED", "executable is not allowlisted");
  }
  if (command === "git" && (argv[1] === undefined || !GIT_SUBCOMMANDS.has(argv[1]))) {
    throw new CaissonError("BINARY_NOT_ALLOWED", "git subcommand is not allowlisted");
  }
}

function auditEvent(input: {
  identity: Identity;
  actionId: string;
  request: LocalToolRequest;
  eventType: string;
  decision: string;
  policyBundleId: string;
  policyReason: string;
  scopeUsed: string;
  durationMs?: number;
  resultBytes?: number;
  resultHash?: string;
  paramsPreview?: string;
  redactionCount?: number;
  errorCode?: string;
  errorMessage?: string;
}) {
  const trace = getActiveTraceIdentifiers();
  return {
    sessionId: input.identity.sessionId,
    actionId: input.actionId,
    eventType: input.eventType,
    actionType: "local_tool",
    service: "guest",
    method: input.request.op,
    decision: input.decision,
    policyBundle: input.policyBundleId,
    policyReason: input.policyReason,
    scopeUsed: input.scopeUsed,
    paramsHash: sha256(JSON.stringify(input.request.body)),
    paramsPreview: input.paramsPreview ?? "",
    driver: input.identity.driver,
    hardwareIsolated: input.identity.hardwareIsolated,
    redactionCount: input.redactionCount ?? 0,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.resultBytes === undefined ? {} : { resultBytes: input.resultBytes }),
    ...(input.resultHash === undefined ? {} : { resultHash: input.resultHash }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    ...(trace === undefined ? {} : trace),
  };
}

function previewFor(
  result: unknown,
  maximumBytes: number,
): { value: string; redactionCount: number } {
  if (containsSecretShape(result))
    return { value: "[redacted secret-shaped result]", redactionCount: 1 };
  const rendered = JSON.stringify(result);
  let preview = "";
  for (const character of rendered) {
    if (Buffer.byteLength(preview + character, "utf8") > maximumBytes) break;
    preview += character;
  }
  return { value: preview, redactionCount: 0 };
}

function auditSafeErrorMessage(message: string): string {
  return containsSecretShape(message) ? "guest reported a redacted failure" : message;
}

function asCaissonError(error: unknown): CaissonError {
  if (error instanceof CaissonError) return error;
  return new CaissonError("BINARY_NOT_ALLOWED", "executable is not allowlisted");
}

function assertPositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
