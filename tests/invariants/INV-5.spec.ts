/**
 * INV-5. Tokens are scoped and expiring.
 * The control plane mints one token at session creation, persists only its argon2id hash, and bounds its lifetime by the session TTL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SessionIdentityResolver,
  SessionTokenService,
} from "../../apps/control-plane/src/session-identity.js";
import { BrokerCallRequestSchema } from "../../packages/protocol/src/index.js";
import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

describe("INV-5: session tokens are opaque, scoped, and expiring", () => {
  let fixture: PostgresFixture;
  let tokens: SessionTokenService;
  let identities: SessionIdentityResolver;
  const hashSessionId = "018f0000-0000-7000-8000-000000000012";
  const expiredSessionId = "018f0000-0000-7000-8000-000000000013";
  const revokedSessionId = "018f0000-0000-7000-8000-000000000014";

  beforeAll(async () => {
    fixture = await createPostgresFixture();
    tokens = new SessionTokenService(fixture.sql);
    identities = new SessionIdentityResolver(fixture.sql);
    await fixture.sql`
      INSERT INTO policy_bundles (id, version, rego_source, wasm_blob, source_hash, created_by)
      VALUES ('018f0000-0000-7000-8000-000000000011', 'test-default', 'package caisson', ${Buffer.from([0])}, 'test-source-hash', 'test')
    `;
    await fixture.sql`
      INSERT INTO sessions (
        id, status, agent_image, approval_mode, scopes, roles, policy_bundle_id,
        requested_by, hardware_isolated, expires_at
      ) VALUES
        (${hashSessionId}, 'ready', 'test-image', 'rule', ARRAY['warehouse.readonly'], ARRAY[]::text[], '018f0000-0000-7000-8000-000000000011', 'test operator', false, '2026-12-31T00:00:00Z'),
        (${expiredSessionId}, 'ready', 'test-image', 'rule', ARRAY['warehouse.readonly'], ARRAY[]::text[], '018f0000-0000-7000-8000-000000000011', 'test operator', false, '2026-12-31T00:00:00Z'),
        (${revokedSessionId}, 'ready', 'test-image', 'rule', ARRAY['warehouse.readonly'], ARRAY[]::text[], '018f0000-0000-7000-8000-000000000011', 'test operator', false, '2026-12-31T00:00:00Z')
    `;
  }, 30_000);

  afterAll(async () => {
    if (fixture !== undefined) {
      await fixture.close();
    }
  });

  it("persists an Argon2id hash only and never accepts a guest token field", async () => {
    const minted = await tokens.mint({
      sessionId: hashSessionId,
      scopes: ["warehouse.readonly"],
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });
    const [stored] = await fixture.sql<{ token_hash: string; scopes: string[] }[]>`
      SELECT token_hash, scopes FROM session_tokens WHERE id = ${minted.id}
    `;

    expect(stored?.token_hash).toMatch(/^\$argon2id\$/);
    expect(stored?.scopes).toEqual(["warehouse.readonly"]);
    expect(
      BrokerCallRequestSchema.safeParse({
        id: "token-forgery",
        op: "broker.call",
        body: {
          service: "postgres",
          method: "query",
          params: { sql: "SELECT 1" },
          idempotencyKey: "token-forgery",
          intent: "present a token",
          token: "forged-token",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects expired and revoked bound tokens", async () => {
    const expired = await tokens.mint({
      sessionId: expiredSessionId,
      scopes: ["warehouse.readonly"],
      expiresAt: new Date("2026-01-01T00:00:00Z"),
    });
    await identities.bind({
      sessionId: expiredSessionId,
      tokenId: expired.id,
      hostId: "host-expired",
      vsockCid: 43,
    });

    await expect(
      identities.resolve(
        { hostId: "host-expired", vsockCid: 43 },
        new Date("2026-02-01T00:00:00Z"),
      ),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });

    const revoked = await tokens.mint({
      sessionId: revokedSessionId,
      scopes: ["warehouse.readonly"],
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });
    await identities.bind({
      sessionId: revokedSessionId,
      tokenId: revoked.id,
      hostId: "host-revoked",
      vsockCid: 44,
    });
    await tokens.revoke(revoked.id, "terminated");

    await expect(
      identities.resolve({ hostId: "host-revoked", vsockCid: 44 }),
    ).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
  });
});
