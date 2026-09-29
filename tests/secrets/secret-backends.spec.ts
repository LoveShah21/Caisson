import { EnvSecretBackend, VaultSecretBackend } from "../../packages/secrets/src/index.js";
import { describe, expect, it } from "vitest";

const document = JSON.stringify({
  kind: "postgres",
  host: "db.internal",
  port: 5432,
  database: "warehouse",
  username: "caisson",
  password: "known-test-secret",
  readCredentials: {
    username: "caisson-reader",
    password: "known-reader-test-secret",
  },
  sslMode: "verify-full",
});

describe("secret backends", () => {
  it("reads structured env credentials without exposing their values", async () => {
    const backend = new EnvSecretBackend({
      environment: { CAISSON_POSTGRES: document },
      caissonEnvironment: "production",
    });
    const credentials = await backend.fetch({
      backend: "env",
      backendPath: "CAISSON_POSTGRES",
      role: "readonly",
    });
    expect(credentials.kind).toBe("postgres");
    expect(JSON.stringify(credentials)).not.toContain("known-test-secret");
    await expect(
      backend.fetch({ backend: "env", backendPath: "../../secret", role: "readonly" }),
    ).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
  });

  it("reads structured S3 credentials without exposing their values", async () => {
    const backend = new EnvSecretBackend({
      environment: {
        CAISSON_S3: JSON.stringify({
          kind: "s3",
          accessKeyId: "caisson-s3-test-key",
          secretAccessKey: "caisson-s3-test-secret",
        }),
      },
      caissonEnvironment: "production",
    });
    const credentials = await backend.fetch({
      backend: "env",
      backendPath: "CAISSON_S3",
      role: "object-store",
    });
    expect(credentials.kind).toBe("s3");
    expect(JSON.stringify(credentials)).not.toContain("caisson-s3-test-secret");
  });

  it("rejects Vault traversal and fails closed on authorization failure", async () => {
    let requests = 0;
    const backend = new VaultSecretBackend({
      address: "https://vault.example.test",
      token: "vault-token-never-log",
      mount: "secret",
      pathPrefix: "caisson",
      timeoutMs: 1_000,
      caissonEnvironment: "production",
      fetchImplementation: async () => {
        requests += 1;
        return new Response("denied", { status: 403 });
      },
    });
    await expect(
      backend.fetch({ backend: "vault", backendPath: "caisson/%2e%2e/admin", role: "readonly" }),
    ).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
    expect(requests).toBe(0);
    await expect(
      backend.fetch({ backend: "vault", backendPath: "caisson/postgres", role: "readonly" }),
    ).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
    expect(requests).toBe(1);
  });

  it("refuses plaintext Vault transport in production", () => {
    expect(
      () =>
        new VaultSecretBackend({
          address: "http://vault.example.test",
          token: "vault-token-never-log",
          mount: "secret",
          pathPrefix: "caisson",
          timeoutMs: 1_000,
          caissonEnvironment: "production",
        }),
    ).toThrow("Vault configuration unavailable");
  });
});
