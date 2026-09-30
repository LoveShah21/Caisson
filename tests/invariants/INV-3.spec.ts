/**
 * INV-3. Policy is enforced outside the guest.
 * Identity, scopes, and roles come from the control plane record resolved through the transport binding.
 * Nothing the guest sends can influence them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SessionIdentityResolver,
  SessionTokenService,
} from "../../apps/control-plane/src/session-identity.js";
import { BrokerCallRequestSchema } from "../../packages/protocol/src/index.js";
import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

describe("INV-3: policy identity is resolved outside the guest", () => {
  let fixture: PostgresFixture;
  let tokens: SessionTokenService;
  let identities: SessionIdentityResolver;

  beforeAll(async () => {
    fixture = await createPostgresFixture();
    tokens = new SessionTokenService(fixture.sql);
    identities = new SessionIdentityResolver(fixture.sql);
    await fixture.sql`
      INSERT INTO policy_bundles (id, version, rego_source, wasm_blob, source_hash, created_by)
      VALUES (
        '018f0000-0000-7000-8000-000000000001',
        'test-default',
        'package caisson',
        ${Buffer.from([0])},
        'test-source-hash',
        'test'
      )
    `;
    await fixture.sql`
      INSERT INTO sessions (
        id, status, agent_image, approval_mode, scopes, roles, policy_bundle_id,
        requested_by, hardware_isolated, driver, expires_at
      ) VALUES (
        '018f0000-0000-7000-8000-000000000002',
        'ready',
        'test-image',
        'rule',
        ARRAY['warehouse.readonly'],
        ARRAY['analyst'],
        '018f0000-0000-7000-8000-000000000001',
        'test operator',
        false,
        'container',
        '2026-12-31T00:00:00Z'
      )
    `;
    const token = await tokens.mint({
      sessionId: "018f0000-0000-7000-8000-000000000002",
      scopes: ["warehouse.readonly"],
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    });
    await identities.bind({
      sessionId: "018f0000-0000-7000-8000-000000000002",
      tokenId: token.id,
      hostId: "host-a",
      transportKind: "vsock",
      peerIdentifier: "42",
    });
  }, 30_000);

  afterAll(async () => {
    if (fixture !== undefined) {
      await fixture.close();
    }
  });

  it("ignores forged session, scopes, roles, and token fields because they are rejected at the frame boundary", () => {
    const result = BrokerCallRequestSchema.safeParse({
      id: "forged-1",
      op: "broker.call",
      body: {
        service: "postgres",
        method: "query",
        params: { sql: "SELECT 1" },
        idempotencyKey: "forged-1",
        intent: "try to escalate",
        sessionId: "attacker-session",
        scopes: ["warehouse.write"],
        roles: ["admin"],
        token: "attacker-token",
      },
    });

    expect(result.success).toBe(false);
  });

  it("uses the host-established connection binding as the sole identity source", async () => {
    const identity = await identities.resolve({
      hostId: "host-a",
      transportKind: "vsock",
      peerIdentifier: "42",
    });

    expect(identity.sessionId).toBe("018f0000-0000-7000-8000-000000000002");
    expect(identity.scopes).toEqual(["warehouse.readonly"]);
    expect(identity.roles).toEqual(["analyst"]);
  });
});
