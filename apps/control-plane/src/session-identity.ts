import { randomBytes } from "node:crypto";

import { CaissonError } from "@caisson/protocol";
import argon2 from "argon2";
import type { Sql } from "postgres";

export interface MintSessionTokenRequest {
  readonly sessionId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
}

export interface MintedSessionToken {
  readonly id: string;
}

export interface TransportBinding {
  readonly sessionId: string;
  readonly tokenId: string;
  readonly hostId: string;
  readonly transportKind: "vsock" | "unix";
  readonly peerIdentifier: string;
}

export interface TransportPeer {
  readonly hostId: string;
  readonly transportKind: "vsock" | "unix";
  readonly peerIdentifier: string;
}

export interface BoundSessionIdentity {
  readonly sessionId: string;
  readonly tokenId: string;
  readonly scopes: readonly string[];
  readonly roles: readonly string[];
  readonly approvalMode: "auto" | "rule" | "always";
  readonly policyBundleId: string;
}

interface IdentityRow {
  readonly session_id: string;
  readonly token_id: string;
  readonly token_scopes: string[];
  readonly token_expires_at: Date;
  readonly token_revoked_at: Date | null;
  readonly session_expires_at: Date;
  readonly session_scopes: string[];
  readonly roles: string[];
  readonly approval_mode: "auto" | "rule" | "always";
  readonly policy_bundle_id: string;
}

export class SessionTokenService {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async mint(request: MintSessionTokenRequest): Promise<MintedSessionToken> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = await argon2.hash(token, { type: argon2.argon2id });
    const id = uuidV7();

    await this.#sql`
      INSERT INTO session_tokens (id, session_id, token_hash, scopes, expires_at)
      VALUES (${id}, ${request.sessionId}, ${tokenHash}, ${[...request.scopes]}, ${request.expiresAt})
    `;

    return { id };
  }

  async revoke(tokenId: string, reason: string): Promise<void> {
    await this.#sql`
      UPDATE session_tokens
      SET revoked_at = now(), revocation_reason = ${reason}
      WHERE id = ${tokenId} AND revoked_at IS NULL
    `;
  }
}

export class SessionIdentityResolver {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async bind(binding: TransportBinding): Promise<void> {
    await this.#sql`
      INSERT INTO transport_bindings (id, session_id, host_id, transport_kind, peer_identifier, token_id)
      VALUES (
        ${uuidV7()},
        ${binding.sessionId},
        ${binding.hostId},
        ${binding.transportKind},
        ${binding.peerIdentifier},
        ${binding.tokenId}
      )
    `;
  }

  async release(peer: TransportPeer): Promise<void> {
    await this.#sql`
      UPDATE transport_bindings
      SET released_at = now()
      WHERE host_id = ${peer.hostId}
        AND transport_kind = ${peer.transportKind}
        AND peer_identifier = ${peer.peerIdentifier}
        AND released_at IS NULL
    `;
  }

  async resolve(peer: TransportPeer, now: Date = new Date()): Promise<BoundSessionIdentity> {
    const [identity] = await this.#sql<IdentityRow[]>`
      SELECT
        binding.session_id,
        binding.token_id,
        token.scopes AS token_scopes,
        token.expires_at AS token_expires_at,
        token.revoked_at AS token_revoked_at,
        session.expires_at AS session_expires_at,
        session.scopes AS session_scopes,
        session.roles,
        session.approval_mode,
        session.policy_bundle_id
      FROM transport_bindings AS binding
      JOIN session_tokens AS token ON token.id = binding.token_id
      JOIN sessions AS session ON session.id = binding.session_id
      WHERE binding.host_id = ${peer.hostId}
        AND binding.transport_kind = ${peer.transportKind}
        AND binding.peer_identifier = ${peer.peerIdentifier}
        AND binding.released_at IS NULL
    `;

    if (identity === undefined) {
      throw new CaissonError("SESSION_NOT_FOUND", "no active transport binding for connection");
    }
    if (
      identity.token_revoked_at !== null ||
      identity.token_expires_at <= now ||
      identity.session_expires_at <= now
    ) {
      throw new CaissonError("SESSION_EXPIRED", "bound session token is expired or revoked");
    }

    return {
      sessionId: identity.session_id,
      tokenId: identity.token_id,
      scopes: intersectScopes(identity.token_scopes, identity.session_scopes),
      roles: identity.roles,
      approvalMode: identity.approval_mode,
      policyBundleId: identity.policy_bundle_id,
    };
  }
}

function intersectScopes(
  tokenScopes: readonly string[],
  sessionScopes: readonly string[],
): string[] {
  const sessionScopeSet = new Set(sessionScopes);
  return tokenScopes.filter((scope) => sessionScopeSet.has(scope));
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
