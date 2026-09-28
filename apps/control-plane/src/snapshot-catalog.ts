import type { SnapshotRef } from "@caisson/isolation";
import { CaissonError } from "@caisson/protocol";
import type { Sql } from "postgres";

/** Persists and promotes verified clean base snapshots in one transaction. */
export class SnapshotCatalog {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async promoteBaseSnapshotAtomically(snapshot: SnapshotRef): Promise<void> {
    if (snapshot.kind !== "base") {
      throw new CaissonError("SANDBOX_FAILED", "only a clean base snapshot may be promoted");
    }
    await this.#sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO snapshots (
          id, kind, bucket, manifest_key, manifest_version, manifest_sha256,
          manifest_size_bytes, manifest_key_id, built_at, promoted_at
        ) VALUES (
          ${snapshot.id}, 'base', ${snapshot.manifest.bucket}, ${snapshot.manifest.key},
          ${snapshot.manifest.versionId ?? null}, ${snapshot.manifest.sha256},
          ${snapshot.manifest.sizeBytes}, ${snapshot.manifestKeyId}, ${new Date(snapshot.createdAt)}, now()
        )
        ON CONFLICT (id) DO NOTHING
      `;
      await transaction`
        INSERT INTO settings (key, value, updated_at, updated_by)
        VALUES ('active_base_snapshot', ${transaction.json({ snapshotId: snapshot.id })}::jsonb, now(), 'snapshot-scheduler')
        ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
      `;
    });
  }

  async activeBaseSnapshot(): Promise<SnapshotRef | undefined> {
    const [row] = await this.#sql<
      {
        id: string;
        bucket: string;
        manifest_key: string;
        manifest_version: string | null;
        manifest_sha256: string;
        manifest_size_bytes: string | number;
        manifest_key_id: string;
        built_at: Date;
      }[]
    >`
      SELECT snapshots.id, bucket, manifest_key, manifest_version, manifest_sha256,
             manifest_size_bytes, manifest_key_id, built_at
      FROM settings
      JOIN snapshots ON snapshots.id = (settings.value ->> 'snapshotId')::uuid
      WHERE settings.key = 'active_base_snapshot' AND snapshots.kind = 'base'
    `;
    if (row === undefined) return undefined;
    return {
      id: row.id,
      kind: "base",
      manifest: {
        bucket: row.bucket,
        key: row.manifest_key,
        ...(row.manifest_version === null ? {} : { versionId: row.manifest_version }),
        sha256: row.manifest_sha256,
        sizeBytes: Number(row.manifest_size_bytes),
      },
      manifestKeyId: row.manifest_key_id,
      createdAt: row.built_at.toISOString(),
    };
  }
}
