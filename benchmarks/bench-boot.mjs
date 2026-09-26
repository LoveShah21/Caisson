import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

import { ContainerDriver } from "../packages/isolation/dist/index.js";

const execFileAsync = promisify(execFile);
const samples = Number.parseInt(process.env.CAISSON_BENCH_SAMPLES ?? "200", 10);
const image = process.env.CAISSON_BENCH_IMAGE ?? "alpine:3.23.3";

if (!Number.isInteger(samples) || samples < 200) {
  throw new Error("CAISSON_BENCH_SAMPLES must be an integer of at least 200");
}

const driver = new ContainerDriver({ warn: () => undefined });
const durations = [];
for (let index = 0; index < samples; index += 1) {
  const startedAt = performance.now();
  const handle = await driver.create({ id: randomUUID(), image });
  await driver.exec(handle, { argv: ["/bin/echo", "hello"] });
  await driver.destroy(handle);
  durations.push(Math.round(performance.now() - startedAt));
}

const sorted = [...durations].sort((left, right) => left - right);
const percentile = (fraction) => sorted[Math.ceil(fraction * sorted.length) - 1];
const outputDirectory = new URL("./results/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });

let dockerVersion = "unavailable";
try {
  const { stdout } = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
  dockerVersion = stdout.trim();
} catch {
  // The benchmark itself already proved Docker was usable. Do not invent a version if this probe fails.
}

const machine = {
  platform: process.platform,
  release: os.release(),
  architecture: process.arch,
  node: process.version,
  docker: dockerVersion,
  cpuModel: os.cpus()[0]?.model ?? "unknown",
  cpuCount: os.cpus().length,
  memoryBytes: os.totalmem(),
};
const result = {
  driver: "container",
  image,
  samples,
  execution: "create, infrastructure exec(/bin/echo hello), destroy",
  p50Ms: percentile(0.5),
  p99Ms: percentile(0.99),
  samplesMs: durations,
  machine,
};

await writeFile(
  new URL("boot-container.json", outputDirectory),
  `${JSON.stringify(result, null, 2)}\n`,
);
await writeFile(
  new URL("machine.md", outputDirectory),
  `${Object.entries(machine)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n")}\n`,
);
