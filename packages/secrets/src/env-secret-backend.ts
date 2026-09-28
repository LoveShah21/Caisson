import { CaissonError } from "@caisson/protocol";

import { type Credentials, parseCredentials } from "./credentials.js";
import type { CredentialRef, SecretBackend } from "./types.js";

const ENVIRONMENT_VARIABLE = /^[A-Z][A-Z0-9_]*$/;

export class EnvSecretBackend implements SecretBackend {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #caissonEnvironment: string | undefined;

  constructor(
    options: {
      readonly environment?: NodeJS.ProcessEnv;
      readonly caissonEnvironment?: string;
    } = {},
  ) {
    this.#environment = options.environment ?? process.env;
    this.#caissonEnvironment = options.caissonEnvironment ?? process.env["CAISSON_ENV"];
  }

  async fetch(ref: CredentialRef): Promise<Credentials> {
    if (ref.backend !== "env" || !ENVIRONMENT_VARIABLE.test(ref.backendPath)) {
      throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
    }
    const value = this.#environment[ref.backendPath];
    if (value === undefined) throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
    try {
      return parseCredentials(JSON.parse(value) as unknown, this.#caissonEnvironment);
    } catch (error: unknown) {
      if (error instanceof CaissonError) throw error;
      throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
    }
  }

  async health(): Promise<boolean> {
    return true;
  }
}
