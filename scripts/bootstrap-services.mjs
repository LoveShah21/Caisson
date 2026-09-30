import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { z } from "zod";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const declarationPath = new URL("../services/bootstrap.json", import.meta.url);
const databaseUrl =
  process.env.CAISSON_DATABASE_URL ??
  "postgres://caisson:caisson-postgres-local-only@localhost:5432/caisson";
const normalizedSecretKeys = new Set([
  "password",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "credential",
  "accesskey",
]);

const ReferenceSchema = z
  .object({
    role: z.string().min(1).max(128),
    backend: z.enum(["env", "vault"]),
    backendPath: z.string().min(1).max(1024),
  })
  .strict();
const DeclarationSchema = z
  .object({
    services: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            adapter: z.string().min(1).max(128),
            config: z.record(z.string().max(128), z.json()),
            credentialRefs: z.array(ReferenceSchema),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const raw = JSON.parse(await readFile(declarationPath, "utf8"));
const declaration = DeclarationSchema.parse(raw);
assertSafeDeclaration(declaration);

const sql = postgres(databaseUrl);
try {
  await sql.begin(async (transaction) => {
    for (const service of declaration.services) {
      const [stored] = await transaction`
        INSERT INTO services (id, name, adapter, config)
        VALUES (${uuidV7()}, ${service.name}, ${service.adapter}, ${transaction.json(service.config)}::jsonb)
        ON CONFLICT (name) DO UPDATE
          SET adapter = EXCLUDED.adapter, config = EXCLUDED.config
        RETURNING id
      `;
      if (stored === undefined) throw new Error("service bootstrap did not return an id");
      for (const reference of service.credentialRefs) {
        await transaction`
          INSERT INTO credential_refs (id, service_id, role, backend, backend_path)
          VALUES (${uuidV7()}, ${stored.id}, ${reference.role}, ${reference.backend}, ${reference.backendPath})
          ON CONFLICT (service_id, role) DO UPDATE
            SET backend = EXCLUDED.backend, backend_path = EXCLUDED.backend_path
        `;
      }
    }
  });
  process.stdout.write(`Bootstrapped ${declaration.services.length} service definitions.\n`);
} finally {
  await sql.end({ timeout: 5 });
}

function assertSafeDeclaration(declaration) {
  for (const service of declaration.services) {
    if (containsSecretShape(service.config)) {
      throw new Error("service bootstrap declaration contains secret-shaped configuration");
    }
    for (const reference of service.credentialRefs) {
      if (matchesSecretValue(reference.backendPath)) {
        throw new Error("service bootstrap declaration contains secret-shaped backend path");
      }
    }
  }
}

function containsSecretShape(value) {
  if (typeof value === "string") return matchesSecretValue(value);
  if (Array.isArray(value)) return value.some(containsSecretShape);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      normalizedSecretKeys.has(key.replace(/[^a-z]/giu, "").toLowerCase()) ||
      containsSecretShape(child),
  );
}

function matchesSecretValue(value) {
  return (
    /AKIA[A-Z0-9]{16}/u.test(value) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value) ||
    /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u.test(value) ||
    /sk-[A-Za-z0-9]{20,}/u.test(value)
  );
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
