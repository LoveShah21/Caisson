import { CaissonError } from "@caisson/protocol";
import type { CredentialRef } from "@caisson/secrets";
import type { Sql } from "postgres";
import { z } from "zod";

import type { BrokerAdapter, BrokerService, BrokerServiceResolver } from "./broker-pipeline.js";

const ServiceConfigSchema = z.object({ timeoutMs: z.number().int().positive() }).passthrough();

interface ServiceRow {
  readonly name: string;
  readonly adapter: string;
  readonly config: unknown;
  readonly enabled: boolean;
}

interface CredentialRefRow {
  readonly backend: "env" | "vault";
  readonly backend_path: string;
  readonly role: string;
}

/** Resolves only host-side metadata. Secret material remains in SecretBackend. */
export class DatabaseBrokerServiceResolver implements BrokerServiceResolver {
  readonly #sql: Sql;
  readonly #adapters: ReadonlyMap<string, BrokerAdapter>;

  constructor(sql: Sql, adapters: readonly BrokerAdapter[]) {
    this.#sql = sql;
    this.#adapters = new Map(adapters.map((adapter) => [adapter.name, adapter]));
  }

  async resolveService(name: string): Promise<BrokerService> {
    const [service] = await this.#sql<ServiceRow[]>`
      SELECT name, adapter, config, enabled FROM services WHERE name = ${name}
    `;
    if (service === undefined || !service.enabled) {
      throw new CaissonError("ADAPTER_NOT_FOUND", "service is unavailable");
    }
    const adapter = this.#adapters.get(service.adapter);
    if (adapter === undefined) {
      throw new CaissonError("ADAPTER_NOT_FOUND", "service adapter is unavailable");
    }
    const config = ServiceConfigSchema.safeParse(service.config);
    if (!config.success) {
      throw new CaissonError("SERVICE_ERROR", "service configuration is invalid");
    }
    return { adapter, timeoutMs: config.data.timeoutMs };
  }

  async resolveCredentialRef(
    serviceName: string,
    role: string,
  ): Promise<CredentialRef | undefined> {
    const [reference] = await this.#sql<CredentialRefRow[]>`
      SELECT reference.backend, reference.backend_path, reference.role
      FROM credential_refs AS reference
      JOIN services AS service ON service.id = reference.service_id
      WHERE service.name = ${serviceName} AND service.enabled = true AND reference.role = ${role}
    `;
    if (reference === undefined) return undefined;
    if (reference.backend !== "env" && reference.backend !== "vault") {
      throw new CaissonError("SECRET_UNAVAILABLE", "credential reference is invalid");
    }
    return {
      backend: reference.backend,
      backendPath: reference.backend_path,
      role: reference.role,
    };
  }
}
