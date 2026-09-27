import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";

import {
  ContainerDriver,
  FirecrackerDriver,
  VsockInfrastructureProbe,
} from "../packages/isolation/dist/index.js";

const execFileAsync = promisify(execFile);
const samples = Number.parseInt(process.env.CAISSON_BENCH_SAMPLES ?? "200", 10);
const image = process.env.CAISSON_BENCH_IMAGE ?? "alpine:3.23.3";
const driverName = process.env.CAISSON_BENCH_DRIVER ?? "container";
const firecrackerBootArgs = "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/init";

if (!Number.isInteger(samples) || samples < 200) {
  throw new Error("CAISSON_BENCH_SAMPLES must be an integer of at least 200");
}
if (driverName !== "container" && driverName !== "firecracker") {
  throw new Error("CAISSON_BENCH_DRIVER must be container or firecracker");
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function createFirecrackerDriver() {
  if (process.env.CAISSON_BENCH_FIRECRACKER !== "1") {
    throw new Error("set CAISSON_BENCH_FIRECRACKER=1 to run the opt-in Firecracker benchmark");
  }
  const rootfsPath = requiredEnvironment("CAISSON_FIRECRACKER_ROOTFS");
  if (basename(rootfsPath) !== "m1-dev-probe-rootfs.ext4") {
    throw new Error("the M-1 Firecracker benchmark requires m1-dev-probe-rootfs.ext4");
  }
  return new FirecrackerDriver({
    firecrackerPath: requiredEnvironment("CAISSON_FIRECRACKER_BIN"),
    kernelImagePath: requiredEnvironment("CAISSON_FIRECRACKER_KERNEL"),
    rootfsPath,
    runtimeDirectory: requiredEnvironment("CAISSON_FIRECRACKER_RUNTIME_DIR"),
    snapshotDirectory: requiredEnvironment("CAISSON_FIRECRACKER_SNAPSHOT_DIR"),
    bootArgs: firecrackerBootArgs,
    infrastructureProbe: new VsockInfrastructureProbe(),
  });
}

async function measureCreate(driver, sandboxImage) {
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    const handle = await driver.create({ id: randomUUID(), image: sandboxImage });
    try {
      const result = await driver.exec(handle, { argv: ["/bin/echo", "hello"] });
      if (result.exitCode !== 0 || result.stdout !== "hello\n") {
        throw new Error("driver exec did not return the expected echo output");
      }
    } finally {
      await driver.destroy(handle);
    }
    durations.push(Math.round(performance.now() - startedAt));
  }
  return durations;
}

async function measureRestore(driver, snapshot) {
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    const handle = await driver.restore(snapshot, { id: randomUUID(), image: "m1-dev-probe" });
    try {
      const result = await driver.exec(handle, { argv: ["/bin/echo", "hello"] });
      if (result.exitCode !== 0 || result.stdout !== "hello\n") {
        throw new Error("restored driver exec did not return the expected echo output");
      }
    } finally {
      await driver.destroy(handle);
    }
    durations.push(Math.round(performance.now() - startedAt));
  }
  return durations;
}

function percentile(samplesMs, fraction) {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

async function dockerVersion() {
  try {
    const { stdout } = await execFileAsync("docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]);
    return stdout.trim();
  } catch {
    return "unavailable";
  }
}

const outputDirectory = new URL("./results/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });

const machine = {
  platform: process.platform,
  release: os.release(),
  architecture: process.arch,
  node: process.version,
  docker: await dockerVersion(),
  cpuModel: os.cpus()[0]?.model ?? "unknown",
  cpuCount: os.cpus().length,
  memoryBytes: os.totalmem(),
};

const results = [];
if (driverName === "container") {
  const durations = await measureCreate(new ContainerDriver({ warn: () => undefined }), image);
  results.push({
    driver: "container",
    kind: "cold",
    image,
    samples,
    execution: "create, infrastructure exec(/bin/echo hello), destroy",
    p50Ms: percentile(durations, 0.5),
    p99Ms: percentile(durations, 0.99),
    samplesMs: durations,
    machine,
  });
} else {
  const driver = createFirecrackerDriver();
  const coldDurations = await measureCreate(driver, "m1-dev-probe");
  results.push({
    driver: "firecracker",
    kind: "cold",
    source: "local kernel and rootfs; S3 snapshot retrieval is scheduled for M-2",
    samples,
    execution: "create, infrastructure exec(/bin/echo hello), destroy",
    p50Ms: percentile(coldDurations, 0.5),
    p99Ms: percentile(coldDurations, 0.99),
    samplesMs: coldDurations,
    machine,
  });

  let source;
  let snapshot;
  try {
    source = await driver.create({ id: randomUUID(), image: "m1-dev-probe" });
    snapshot = await driver.snapshot(source, "base");
  } finally {
    if (source !== undefined) {
      await driver.destroy(source);
    }
  }

  try {
    const warmDurations = await measureRestore(driver, snapshot);
    results.push({
      driver: "firecracker",
      kind: "warm",
      source: "local base snapshot",
      samples,
      execution: "restore, infrastructure exec(/bin/echo hello), destroy",
      p50Ms: percentile(warmDurations, 0.5),
      p99Ms: percentile(warmDurations, 0.99),
      samplesMs: warmDurations,
      machine,
    });
  } finally {
    await Promise.all([
      rm(snapshot.statePath, { force: true }),
      rm(snapshot.memoryPath, { force: true }),
    ]);
  }
}

for (const result of results) {
  const filename =
    result.driver === "container" ? "boot-container.json" : `boot-firecracker-${result.kind}.json`;
  await writeFile(new URL(filename, outputDirectory), `${JSON.stringify(result, null, 2)}\n`);
}
await writeFile(
  new URL("machine.md", outputDirectory),
  `${Object.entries(machine)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n")}\n`,
);
