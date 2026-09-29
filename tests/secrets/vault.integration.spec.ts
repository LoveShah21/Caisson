import { VaultSecretBackend } from "../../packages/secrets/src/index.js";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT_TOKEN = "vault-test-token-not-a-production-secret";
let backend: VaultSecretBackend;
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const container = await new GenericContainer("hashicorp/vault:1.20.1")
    .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: ROOT_TOKEN })
    .withCommand(["server", "-dev", "-dev-listen-address=0.0.0.0:8200"])
    .withExposedPorts(8200)
    .withWaitStrategy(Wait.forLogMessage("Root Token:"))
    .start();
  stop = async () => container.stop();
  const address = `http://${container.getHost()}:${container.getMappedPort(8200)}`;
  const response = await fetch(`${address}/v1/secret/data/caisson/postgres`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Vault-Token": ROOT_TOKEN },
    body: JSON.stringify({
      data: {
        kind: "postgres",
        host: "db.internal",
        port: 5432,
        database: "warehouse",
        username: "caisson",
        password: "vault-integration-secret",
        readCredentials: {
          username: "caisson-reader",
          password: "vault-reader-integration-secret",
        },
        sslMode: "verify-full",
      },
    }),
  });
  if (!response.ok) throw new Error("unable to seed Vault integration fixture");
  backend = new VaultSecretBackend({
    address,
    token: ROOT_TOKEN,
    mount: "secret",
    pathPrefix: "caisson",
    timeoutMs: 5_000,
    caissonEnvironment: "development",
  });
}, 60_000);

afterAll(async () => stop?.());

describe("VaultSecretBackend integration", () => {
  it("reads KV-v2 credentials and never serializes the secret", async () => {
    const credentials = await backend.fetch({
      backend: "vault",
      backendPath: "caisson/postgres",
      role: "readonly",
    });
    expect(credentials.host).toBe("db.internal");
    expect(JSON.stringify(credentials)).not.toContain("vault-integration-secret");
  });
});
