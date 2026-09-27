import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { basename, dirname } from "node:path";
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

class BenchmarkTransportHost {
  #servers = new Map();
  #attachments = new Map();

  async reserve(descriptor) {
    const endpointPath =
      descriptor.kind === "unix"
        ? descriptor.peerIdentifier
        : `${os.tmpdir()}/caisson-benchmark-transport/${randomUUID()}.sock`;
    await mkdir(dirname(endpointPath), { mode: 0o700, recursive: true });
    await chmod(dirname(endpointPath), 0o700);
    const attachment = { descriptor, endpointPath };
    this.#attachments.set(descriptor.peerIdentifier, attachment);
    if (descriptor.kind !== "unix") return attachment;
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpointPath, resolve);
    });
    await chmod(endpointPath, 0o600);
    const stat = await lstat(endpointPath);
    if (!stat.isSocket() || (stat.mode & 0o077) !== 0) {
      throw new Error("benchmark transport socket must be owner-only");
    }
    this.#servers.set(descriptor.peerIdentifier, server);
    return attachment;
  }

  async release(descriptor) {
    const server = this.#servers.get(descriptor.peerIdentifier);
    if (server !== undefined) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
    await rm(
      this.#attachments.get(descriptor.peerIdentifier)?.endpointPath ?? descriptor.peerIdentifier,
      {
        force: true,
      },
    );
    this.#servers.delete(descriptor.peerIdentifier);
    this.#attachments.delete(descriptor.peerIdentifier);
  }
}

async function destroyAndRelease(driver, prepared, transportHost) {
  await driver.destroy(prepared.handle);
  await transportHost.release(prepared.transport);
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
    const transportHost = new BenchmarkTransportHost();
    const prepared = await driver.prepare({ id: randomUUID(), image: sandboxImage }, transportHost);
    await driver.start(prepared.handle);
    const handle = prepared.handle;
    try {
      const result = await driver.exec(handle, { argv: ["/bin/echo", "hello"] });
      if (result.exitCode !== 0 || result.stdout !== "hello\n") {
        throw new Error("driver exec did not return the expected echo output");
      }
    } finally {
      await destroyAndRelease(driver, prepared, transportHost);
    }
    durations.push(Math.round(performance.now() - startedAt));
  }
  return durations;
}

async function measureRestore(driver, snapshot) {
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    const transportHost = new BenchmarkTransportHost();
    const prepared = await driver.restore(
      snapshot,
      { id: randomUUID(), image: "m1-dev-probe" },
      transportHost,
    );
    await driver.start(prepared.handle);
    const handle = prepared.handle;
    try {
      const result = await driver.exec(handle, { argv: ["/bin/echo", "hello"] });
      if (result.exitCode !== 0 || result.stdout !== "hello\n") {
        throw new Error("restored driver exec did not return the expected echo output");
      }
    } finally {
      await destroyAndRelease(driver, prepared, transportHost);
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
    timingModel: "prepare_start_exec_destroy",
    execution: "prepare, start, infrastructure exec(/bin/echo hello), destroy",
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
    timingModel: "prepare_start_exec_destroy",
    execution: "prepare, start, infrastructure exec(/bin/echo hello), destroy",
    p50Ms: percentile(coldDurations, 0.5),
    p99Ms: percentile(coldDurations, 0.99),
    samplesMs: coldDurations,
    machine,
  });

  let source;
  let sourcePrepared;
  let sourceTransportHost;
  let snapshot;
  try {
    sourceTransportHost = new BenchmarkTransportHost();
    sourcePrepared = await driver.prepare(
      { id: randomUUID(), image: "m1-dev-probe" },
      sourceTransportHost,
    );
    await driver.start(sourcePrepared.handle);
    source = sourcePrepared.handle;
    snapshot = await driver.snapshot(source, "base");
  } finally {
    if (sourcePrepared !== undefined && sourceTransportHost !== undefined) {
      await destroyAndRelease(driver, sourcePrepared, sourceTransportHost);
    }
  }

  try {
    const warmDurations = await measureRestore(driver, snapshot);
    results.push({
      driver: "firecracker",
      kind: "warm",
      source: "local base snapshot",
      samples,
      timingModel: "restore_exec_destroy",
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
    .join(
      "\n",
    )}\n\nMeasurements with timingModel prepare_start_exec_destroy supersede the pre-ADR-18 create_exec_destroy results. The lifecycle boundary changed, so the two result sets are not comparable.\n`,
);
