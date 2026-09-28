import { CaissonError } from "@caisson/protocol";

import { type Credentials, parseCredentials } from "./credentials.js";
import type { CredentialRef, SecretBackend } from "./types.js";

export interface VaultSecretBackendOptions {
  readonly address: string;
  readonly token: string;
  readonly mount: string;
  readonly pathPrefix: string;
  readonly timeoutMs: number;
  readonly caissonEnvironment?: string;
  readonly fetchImplementation?: typeof fetch;
}

interface VaultResponse {
  readonly data?: { readonly data?: unknown };
}

export class VaultSecretBackend implements SecretBackend {
  readonly #address: URL;
  readonly #token: string;
  readonly #mount: string;
  readonly #pathPrefix: string;
  readonly #timeoutMs: number;
  readonly #caissonEnvironment: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: VaultSecretBackendOptions) {
    this.#address = new URL(options.address);
    this.#token = options.token;
    this.#mount = assertPathSegment(options.mount);
    this.#pathPrefix = assertVaultPath(options.pathPrefix);
    this.#timeoutMs = options.timeoutMs;
    this.#caissonEnvironment = options.caissonEnvironment ?? process.env["CAISSON_ENV"];
    this.#fetch = options.fetchImplementation ?? fetch;
    if (
      this.#token.length === 0 ||
      this.#timeoutMs <= 0 ||
      (this.#caissonEnvironment === "production" && this.#address.protocol !== "https:")
    ) {
      throw new CaissonError("SECRET_UNAVAILABLE", "Vault configuration unavailable");
    }
  }

  async fetch(ref: CredentialRef): Promise<Credentials> {
    if (ref.backend !== "vault")
      throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
    const path = assertVaultPath(ref.backendPath);
    if (path !== this.#pathPrefix && !path.startsWith(`${this.#pathPrefix}/`)) {
      throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
    }
    const response = await this.#request(`v1/${this.#mount}/data/${path}`);
    if (!response.ok) throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
    try {
      const body = (await response.json()) as VaultResponse;
      return parseCredentials(body.data?.data, this.#caissonEnvironment);
    } catch (error: unknown) {
      if (error instanceof CaissonError) throw error;
      throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
    }
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.#request("v1/sys/health");
      return response.status >= 200 && response.status < 500;
    } catch {
      return false;
    }
  }

  async #request(path: string): Promise<Response> {
    try {
      return await this.#fetch(new URL(path, this.#address).toString(), {
        headers: { "X-Vault-Token": this.#token },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
    }
  }
}

function assertPathSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new CaissonError("SECRET_UNAVAILABLE", "Vault configuration unavailable");
  return value;
}

function assertVaultPath(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("%") ||
    value
      .split("/")
      .some(
        (part) => part === "" || part === "." || part === ".." || !/^[A-Za-z0-9_-]+$/.test(part),
      )
  ) {
    throw new CaissonError("SECRET_UNAVAILABLE", "credential unavailable");
  }
  return value;
}
