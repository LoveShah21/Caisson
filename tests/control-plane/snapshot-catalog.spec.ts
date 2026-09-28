import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SnapshotCatalog } from "../../apps/control-plane/src/snapshot-catalog.js";
import { createPostgresFixture, type PostgresFixture } from "../helpers/postgres.js";

let database: PostgresFixture;

beforeAll(async () => {
  database = await createPostgresFixture();
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("SnapshotCatalog", () => {
  it("persists a base snapshot and atomically makes it active", async () => {
    const catalog = new SnapshotCatalog(database.sql);
    const snapshot = {
      id: "019c0000-0000-7000-8000-000000000001",
      kind: "base" as const,
      manifest: {
        bucket: "caisson-snapshots",
        key: "snapshots/base/one/manifest.json",
        versionId: "v1",
        sha256: "a".repeat(64),
        sizeBytes: 123,
      },
      manifestKeyId: "manifest-key-a",
      createdAt: "2026-09-28T00:00:00.000Z",
    };

    await catalog.promoteBaseSnapshotAtomically(snapshot);

    await expect(catalog.activeBaseSnapshot()).resolves.toEqual(snapshot);
    const [setting] = await database.sql<{ value: { snapshotId: string } }[]>`
      SELECT value FROM settings WHERE key = 'active_base_snapshot'
    `;
    expect(setting?.value.snapshotId).toBe(snapshot.id);
  });

  it("does not promote a snapshot when updating the active pointer fails", async () => {
    const catalog = new SnapshotCatalog(database.sql);
    const snapshot = {
      id: "019c0000-0000-7000-8000-000000000002",
      kind: "base" as const,
      manifest: {
        bucket: "caisson-snapshots",
        key: "snapshots/base/two/manifest.json",
        sha256: "b".repeat(64),
        sizeBytes: 123,
      },
      manifestKeyId: "manifest-key-a",
      createdAt: "2026-09-28T00:00:00.000Z",
    };

    await database.sql.unsafe(`
      CREATE FUNCTION fail_active_base_snapshot_promotion() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'simulated promotion interruption';
      END;
      $$ LANGUAGE plpgsql
    `);
    await database.sql.unsafe(`
      CREATE TRIGGER fail_active_base_snapshot_promotion
      BEFORE INSERT OR UPDATE ON settings
      FOR EACH ROW
      WHEN (NEW.key = 'active_base_snapshot')
      EXECUTE FUNCTION fail_active_base_snapshot_promotion()
    `);

    try {
      await expect(catalog.promoteBaseSnapshotAtomically(snapshot)).rejects.toThrow(
        "simulated promotion interruption",
      );
    } finally {
      await database.sql.unsafe("DROP TRIGGER fail_active_base_snapshot_promotion ON settings");
      await database.sql.unsafe("DROP FUNCTION fail_active_base_snapshot_promotion()");
    }

    const [storedSnapshot] = await database.sql<{ id: string }[]>`
      SELECT id FROM snapshots WHERE id = ${snapshot.id}
    `;
    expect(storedSnapshot).toBeUndefined();
  });
});
