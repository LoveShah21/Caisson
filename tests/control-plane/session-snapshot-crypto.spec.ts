import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SessionSnapshotCrypto } from "../../apps/control-plane/src/session-snapshot-crypto.js";
import { SecretString } from "../../packages/secrets/src/credentials.js";
import type { SecretBackend } from "../../packages/secrets/src/types.js";

const rootKey = randomBytes(32).toString("base64");
const ref = { backend: "env" as const, backendPath: "CAISSON_TEST_ROOT_KEK", role: "snapshot-kek" };

describe("SessionSnapshotCrypto", () => {
  it("keeps sibling snapshot DEKs independent and requires the originating session KEK", async () => {
    const crypto = new SessionSnapshotCrypto(new TestSnapshotKeyBackend(rootKey), ref);
    const sessionKek = await crypto.createWrappedSessionKek();
    const siblingSessionKek = await crypto.createWrappedSessionKek();
    const firstDek = await crypto.createWrappedSnapshotDek(sessionKek);
    const secondDek = await crypto.createWrappedSnapshotDek(sessionKek);
    const aad = Buffer.from("session-a/snapshot-a/state", "utf8");
    const encryptedFirst = await crypto.encrypt(
      Buffer.from("first", "utf8"),
      sessionKek,
      firstDek,
      aad,
    );
    const encryptedSecond = await crypto.encrypt(
      Buffer.from("second", "utf8"),
      sessionKek,
      secondDek,
      aad,
    );

    // Losing firstDek is the retention erasure boundary. Its sibling still
    // decrypts with its own distinct wrapped DEK.
    await expect(crypto.decrypt(encryptedSecond, sessionKek, secondDek, aad)).resolves.toEqual(
      Buffer.from("second", "utf8"),
    );
    await expect(crypto.decrypt(encryptedFirst, siblingSessionKek, firstDek, aad)).rejects.toThrow(
      "session snapshot key unwrap failed",
    );
  });
});

class TestSnapshotKeyBackend implements SecretBackend {
  readonly #key: string;
  constructor(key: string) {
    this.#key = key;
  }
  async fetch() {
    return {
      kind: "snapshot_kek" as const,
      keyId: "test-root-kek",
      key: new SecretString(this.#key),
    };
  }
  async health(): Promise<boolean> {
    return true;
  }
}
