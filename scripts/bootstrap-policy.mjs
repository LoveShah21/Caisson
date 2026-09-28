import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const policyDirectory = join(repositoryRoot, "policies", "bootstrap");
const sourcePath = join(policyDirectory, "default.rego");
const opaImage =
  "openpolicyagent/opa@sha256:22770e039a71a885231059c93166cce0644db256cab751043d94bfd150f220d5";
const databaseUrl =
  process.env.CAISSON_DATABASE_URL ??
  "postgres://caisson:caisson-postgres-local-only@localhost:5432/caisson";

const source = await readFile(sourcePath, "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex");
const outputDirectory = await mkdtemp(join(tmpdir(), "caisson-policy-bootstrap-"));
const bundlePath = join(outputDirectory, "default.tar.gz");

try {
  const migrationSql = postgres(databaseUrl);
  try {
    const [schema] = await migrationSql`SELECT to_regclass('public.settings') AS settings_table`;
    if (schema?.settings_table === null) {
      throw new Error("database migrations must run before policy bootstrap");
    }
  } finally {
    await migrationSql.end({ timeout: 5 });
  }

  runOpaBuild(outputDirectory);
  const wasm = await extractPolicyWasm(await readFile(bundlePath));
  const sql = postgres(databaseUrl);

  try {
    await sql.begin(async (transaction) => {
      const [existing] = await transaction`
        SELECT id FROM policy_bundles WHERE source_hash = ${sourceHash}
      `;
      const bundleId = existing?.id ?? uuidV7();

      if (existing === undefined) {
        await transaction`
          INSERT INTO policy_bundles (
            id, version, rego_source, wasm_blob, source_hash, created_by, notes
          ) VALUES (
            ${bundleId},
            ${`bootstrap-default-${sourceHash.slice(0, 12)}`},
            ${source},
            ${wasm},
            ${sourceHash},
            'bootstrap:policy',
            'Minimal default-deny and scope-check bundle'
          )
        `;
      }

      const [active] = await transaction`
        SELECT key FROM settings WHERE key = 'active_policy_bundle' FOR UPDATE
      `;
      if (active === undefined) {
        await transaction`
          INSERT INTO settings (key, value, updated_by)
          VALUES ('active_policy_bundle', ${{ policyBundleId: bundleId }}::jsonb, 'bootstrap:policy')
        `;
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  process.stdout.write(
    `Bootstrapped policy bundle (${wasm.byteLength} bytes) from ${sourceHash}.\n`,
  );
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}

function runOpaBuild(outputDirectory) {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--mount",
      `type=bind,source=${policyDirectory},target=/src,readonly`,
      "--mount",
      `type=bind,source=${outputDirectory},target=/out`,
      opaImage,
      "build",
      "-t",
      "wasm",
      "-e",
      "caisson/bootstrap/decision",
      "-o",
      "/out/default.tar.gz",
      "/src/default.rego",
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("OPA policy compilation failed");
  }
}

async function extractPolicyWasm(bundle) {
  const decompressed = await new Response(
    new Blob([bundle]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer();
  const archive = Buffer.from(decompressed);

  for (let offset = 0; offset + 512 <= archive.length; ) {
    const name = archive
      .subarray(offset, offset + 100)
      .toString("utf8")
      .replace(/\0.*$/, "");
    const sizeText = archive
      .subarray(offset + 124, offset + 136)
      .toString("utf8")
      .replace(/\0.*$/, "")
      .trim();
    const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
    const contentStart = offset + 512;
    if (name.endsWith("policy.wasm")) {
      return archive.subarray(contentStart, contentStart + size);
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  throw new Error("OPA bundle did not contain policy.wasm");
}

function uuidV7() {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
