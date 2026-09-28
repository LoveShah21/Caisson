import type { Credentials } from "./credentials.js";

export interface CredentialRef {
  readonly backend: "env" | "vault";
  readonly backendPath: string;
  readonly role: string;
}

export interface SecretBackend {
  fetch(ref: CredentialRef): Promise<Credentials>;
  health(): Promise<boolean>;
}
