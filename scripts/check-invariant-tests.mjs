import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../tests/invariants/", import.meta.url));
const names = await readdir(directory);
const prohibited = /\.(?:skip|only)\s*\(/u;

for (const name of names.filter((entry) => entry.endsWith(".spec.ts"))) {
  const path = join(directory, name);
  const source = await readFile(path, "utf8");
  if (prohibited.test(source)) {
    throw new Error(`Invariant test ${name} contains .skip() or .only()`);
  }
}
