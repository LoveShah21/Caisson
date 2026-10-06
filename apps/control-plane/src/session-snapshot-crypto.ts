import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { CaissonError } from "@caisson/protocol";
import type { CredentialRef, SecretBackend } from "@caisson/secrets";

const KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** Session KEK wrapped by the root KEK held behind SecretBackend. */
export interface WrappedSessionKek {
  readonly keyId: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
}

/** Fresh DEK for one snapshot, wrapped by its originating session KEK. */
export interface WrappedSnapshotDek {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
}

export interface EncryptedSnapshotBytes {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

/** Implements ADR-48's root-KEK -> session-KEK -> snapshot-DEK hierarchy. */
export class SessionSnapshotCrypto {
  readonly #backend: SecretBackend;
  readonly #keyRef: CredentialRef;

  constructor(backend: SecretBackend, keyRef: CredentialRef) {
    this.#backend = backend;
    this.#keyRef = keyRef;
  }

  async createWrappedSessionKek(): Promise<WrappedSessionKek> {
    const sessionKek = randomBytes(KEY_BYTES);
    try {
      const root = await this.#rootKek();
      try {
        const wrapped = wrap(
          sessionKek,
          root.bytes,
          Buffer.from(`caisson/session-kek/${root.keyId}`, "utf8"),
        );
        return { keyId: root.keyId, ...wrapped };
      } finally {
        root.bytes.fill(0);
      }
    } finally {
      sessionKek.fill(0);
    }
  }

  async createWrappedSnapshotDek(sessionKek: WrappedSessionKek): Promise<WrappedSnapshotDek> {
    const plainSessionKek = await this.#unwrapSessionKek(sessionKek);
    const snapshotDek = randomBytes(KEY_BYTES);
    try {
      return wrap(snapshotDek, plainSessionKek, Buffer.from("caisson/snapshot-dek", "utf8"));
    } finally {
      plainSessionKek.fill(0);
      snapshotDek.fill(0);
    }
  }

  async encrypt(
    plain: Buffer,
    sessionKek: WrappedSessionKek,
    snapshotDek: WrappedSnapshotDek,
    aad: Buffer,
  ): Promise<EncryptedSnapshotBytes> {
    const dek = await this.#unwrapSnapshotDek(sessionKek, snapshotDek);
    try {
      const nonce = randomBytes(GCM_NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", dek, nonce);
      cipher.setAAD(aad);
      return {
        nonce,
        ciphertext: Buffer.concat([cipher.update(plain), cipher.final()]),
        tag: cipher.getAuthTag(),
      };
    } finally {
      dek.fill(0);
    }
  }

  async decrypt(
    encrypted: EncryptedSnapshotBytes,
    sessionKek: WrappedSessionKek,
    snapshotDek: WrappedSnapshotDek,
    aad: Buffer,
  ): Promise<Buffer> {
    if (
      encrypted.nonce.byteLength !== GCM_NONCE_BYTES ||
      encrypted.tag.byteLength !== GCM_TAG_BYTES
    ) {
      throw new CaissonError("SANDBOX_FAILED", "session snapshot encryption metadata is invalid");
    }
    const dek = await this.#unwrapSnapshotDek(sessionKek, snapshotDek);
    try {
      const decipher = createDecipheriv("aes-256-gcm", dek, encrypted.nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(encrypted.tag);
      return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
    } catch (error: unknown) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "session snapshot decryption failed",
        undefined,
        error,
      );
    } finally {
      dek.fill(0);
    }
  }

  async #unwrapSessionKek(wrapped: WrappedSessionKek): Promise<Buffer> {
    const root = await this.#rootKek(wrapped.keyId);
    try {
      return unwrap(
        wrapped,
        root.bytes,
        Buffer.from(`caisson/session-kek/${wrapped.keyId}`, "utf8"),
      );
    } finally {
      root.bytes.fill(0);
    }
  }

  async #unwrapSnapshotDek(
    sessionKek: WrappedSessionKek,
    snapshotDek: WrappedSnapshotDek,
  ): Promise<Buffer> {
    const plainSessionKek = await this.#unwrapSessionKek(sessionKek);
    try {
      return unwrap(snapshotDek, plainSessionKek, Buffer.from("caisson/snapshot-dek", "utf8"));
    } finally {
      plainSessionKek.fill(0);
    }
  }

  async #rootKek(expectedKeyId?: string): Promise<{ keyId: string; bytes: Buffer }> {
    const credentials = await this.#backend.fetch(this.#keyRef);
    if (
      credentials.kind !== "snapshot_kek" ||
      (expectedKeyId !== undefined && credentials.keyId !== expectedKeyId)
    ) {
      throw new CaissonError("SECRET_UNAVAILABLE", "session snapshot wrapping key is unavailable");
    }
    const bytes = Buffer.from(credentials.key.reveal(), "base64");
    if (bytes.byteLength !== KEY_BYTES) {
      bytes.fill(0);
      throw new CaissonError("SECRET_UNAVAILABLE", "session snapshot wrapping key is unavailable");
    }
    return { keyId: credentials.keyId, bytes };
  }
}

function wrap(value: Buffer, key: Buffer, aad: Buffer): WrappedSnapshotDek {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  return {
    nonce,
    ciphertext: Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()]),
  };
}

function unwrap(wrapped: WrappedSnapshotDek, key: Buffer, aad: Buffer): Buffer {
  if (
    wrapped.nonce.byteLength !== GCM_NONCE_BYTES ||
    wrapped.ciphertext.byteLength !== KEY_BYTES + GCM_TAG_BYTES
  ) {
    throw new CaissonError("SANDBOX_FAILED", "wrapped session snapshot key is invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, wrapped.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(wrapped.ciphertext.subarray(KEY_BYTES));
    return Buffer.concat([
      decipher.update(wrapped.ciphertext.subarray(0, KEY_BYTES)),
      decipher.final(),
    ]);
  } catch (error: unknown) {
    throw new CaissonError(
      "SANDBOX_FAILED",
      "session snapshot key unwrap failed",
      undefined,
      error,
    );
  }
}
