import { CaissonError, type PolicyDecision, PolicyDecisionSchema } from "@caisson/protocol";
import { type LoadedPolicy, loadPolicy } from "@open-policy-agent/opa-wasm";
import type { Sql } from "postgres";
import { z } from "zod";

const PolicyResultSchema = z
  .object({
    decision: PolicyDecisionSchema,
    reason: z.string().min(1).max(512),
    obligations: z.array(z.string().min(1).max(128)).max(32),
  })
  .strict();

export interface PolicyDecisionResult {
  readonly decision: PolicyDecision;
  readonly reason: string;
  readonly obligations: readonly string[];
}

export interface LoadedPolicyBundle {
  readonly id: string;
  readonly version: string;
  readonly evaluator: PolicyEvaluator;
}

interface PolicyBundleRow {
  readonly id: string;
  readonly version: string;
  readonly wasm_blob: Buffer;
}

/** Evaluates one trusted, already-compiled OPA WASM bundle in process. */
export class PolicyEvaluator {
  readonly #policy: LoadedPolicy;

  private constructor(policy: LoadedPolicy) {
    this.#policy = policy;
  }

  static async fromWasm(wasm: Uint8Array): Promise<PolicyEvaluator> {
    try {
      return new PolicyEvaluator(await loadPolicy(new Uint8Array(wasm)));
    } catch (error: unknown) {
      throw new CaissonError(
        "POLICY_UNAVAILABLE",
        "policy bundle could not be loaded",
        undefined,
        error,
      );
    }
  }

  evaluate(input: Record<string, unknown>): PolicyDecisionResult {
    try {
      const results: unknown = this.#policy.evaluate(input);
      if (!Array.isArray(results) || results.length !== 1) {
        throw new CaissonError("POLICY_UNAVAILABLE", "policy bundle returned an invalid result");
      }
      const entry = results[0];
      if (typeof entry !== "object" || entry === null || !("result" in entry)) {
        throw new CaissonError("POLICY_UNAVAILABLE", "policy bundle returned an invalid result");
      }
      return PolicyResultSchema.parse(entry.result);
    } catch (error: unknown) {
      if (error instanceof CaissonError) throw error;
      throw new CaissonError("POLICY_UNAVAILABLE", "policy evaluation failed", undefined, error);
    }
  }
}

export class PolicyBundleLoader {
  readonly #sql: Sql;
  readonly #loaded = new Map<string, LoadedPolicyBundle>();

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async load(bundleId: string): Promise<LoadedPolicyBundle> {
    const cached = this.#loaded.get(bundleId);
    if (cached !== undefined) return cached;
    const [bundle] = await this.#sql<PolicyBundleRow[]>`
      SELECT id, version, wasm_blob
      FROM policy_bundles
      WHERE id = ${bundleId} AND retired_at IS NULL
    `;
    if (bundle === undefined) {
      throw new CaissonError("POLICY_UNAVAILABLE", "policy bundle is unavailable");
    }
    const loaded = {
      id: bundle.id,
      version: bundle.version,
      evaluator: await PolicyEvaluator.fromWasm(bundle.wasm_blob),
    };
    this.#loaded.set(bundleId, loaded);
    return loaded;
  }

  async loadActive(): Promise<LoadedPolicyBundle> {
    const [setting] = await this.#sql<{ value: { policyBundleId?: unknown } }[]>`
      SELECT value FROM settings WHERE key = 'active_policy_bundle'
    `;
    if (
      setting === undefined ||
      typeof setting.value.policyBundleId !== "string" ||
      setting.value.policyBundleId.length === 0
    ) {
      throw new CaissonError("POLICY_UNAVAILABLE", "active policy bundle is unavailable");
    }
    return this.load(setting.value.policyBundleId);
  }
}
