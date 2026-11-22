import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { opaImage, runPolicyTests } from "./policy-opa.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const policyDirectory = join(repositoryRoot, "policies", "bootstrap");
const sourcePath = join(policyDirectory, "default.rego");
const testPath = join(policyDirectory, "default_test.rego");
const databaseUrl =
  process.env.CAISSON_DATABASE_URL ??
  "postgres://caisson:caisson-postgres-local-only@localhost:5432/caisson";

const source = await readFile(sourcePath, "utf8");
const tests = await readFile(testPath, "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex");
const outputDirectory = await mkdtemp(join(tmpdir(), "caisson-policy-bootstrap-"));
// The pinned OPA image runs as a non-root user. Docker bind mounts retain host
// ownership, so grant that isolated temporary directory write permission only.
await chmod(outputDirectory, 0o777);
await writeFile(join(outputDirectory, "default.rego"), source, { mode: 0o644 });
await writeFile(join(outputDirectory, "default_test.rego"), tests, { mode: 0o644 });
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

  await runPolicyTests(outputDirectory);
  runOpaBuild(outputDirectory);
  const wasm = await extractPolicyWasm(await readFile(bundlePath));
  const testAttestationSha256 = policyTestAttestation(source, tests, wasm);
  const sql = postgres(databaseUrl);

  try {
    await sql.begin(async (transaction) => {
      const [existing] = await transaction`
        SELECT id, wasm_blob FROM policy_bundles WHERE source_hash = ${sourceHash}
        ORDER BY created_at LIMIT 1 FOR UPDATE
      `;
      const bundleId = existing?.id ?? uuidV7();

      if (existing === undefined) {
        await transaction`
          INSERT INTO policy_bundles (
            id, version, rego_source, rego_test_source, wasm_blob, source_hash,
            test_attestation_sha256, created_by, notes
          ) VALUES (
            ${bundleId},
            ${`bootstrap-default-${sourceHash.slice(0, 12)}`},
            ${source},
            ${tests},
            ${wasm},
            ${sourceHash},
            ${testAttestationSha256},
            'bootstrap:policy',
            'Minimal default-deny and scope-check bundle'
          )
        `;
      } else {
        if (!Buffer.from(existing.wasm_blob).equals(wasm)) {
          throw new Error("existing policy bundle WASM differs from the pinned bootstrap build");
        }
        await transaction`
          UPDATE policy_bundles
          SET rego_test_source = ${tests}, test_attestation_sha256 = ${testAttestationSha256}
          WHERE id = ${bundleId}
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
      `type=bind,source=${outputDirectory},target=/src,readonly`,
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
    { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0) {
    throw new Error(
      `OPA policy compilation failed: ${result.stderr || result.stdout || result.error?.message || "unknown Docker failure"}`,
    );
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

function policyTestAttestation(source, tests, wasm) {
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  return sha256(`caisson-policy-tests-v1\n${sha256(source)}\n${sha256(tests)}\n${sha256(wasm)}\n`);
}
