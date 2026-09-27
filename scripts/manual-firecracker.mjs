import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

function fail(message) {
  console.error(`FAIL Firecracker manual integration: ${message}`);
  process.exit(1);
}

if (process.env.CAISSON_MANUAL_FC_TEST !== "1") {
  fail("set CAISSON_MANUAL_FC_TEST=1 to run the opt-in check");
}

const required = [
  "CAISSON_FIRECRACKER_BIN",
  "CAISSON_FIRECRACKER_KERNEL",
  "CAISSON_FIRECRACKER_ROOTFS",
  "CAISSON_FIRECRACKER_RUNTIME_DIR",
  "CAISSON_FIRECRACKER_SNAPSHOT_DIR",
];
for (const name of required) {
  if (process.env[name] === undefined || process.env[name] === "") {
    fail(`missing required environment variable ${name}`);
  }
}

const rootfs = process.env.CAISSON_FIRECRACKER_ROOTFS;
if (basename(rootfs) !== "m1-dev-probe-rootfs.ext4") {
  fail("manual M-1 verification requires m1-dev-probe-rootfs.ext4");
}

const [{ FirecrackerDriver, VsockInfrastructureProbe }, { CaissonError }] = await Promise.all([
  import("../packages/isolation/dist/index.js"),
  import("../packages/protocol/dist/index.js"),
]);
const driver = new FirecrackerDriver({
  firecrackerPath: process.env.CAISSON_FIRECRACKER_BIN,
  kernelImagePath: process.env.CAISSON_FIRECRACKER_KERNEL,
  rootfsPath: rootfs,
  runtimeDirectory: process.env.CAISSON_FIRECRACKER_RUNTIME_DIR,
  snapshotDirectory: process.env.CAISSON_FIRECRACKER_SNAPSHOT_DIR,
  bootArgs: "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/init",
  infrastructureProbe: new VsockInfrastructureProbe(),
});

const spec = { id: randomUUID(), image: "m1-dev-probe" };
const attachments = new Map();
const transportHost = {
  async reserve(descriptor) {
    const endpointPath = join(
      process.env.CAISSON_FIRECRACKER_RUNTIME_DIR,
      "transport",
      `${randomUUID()}.sock`,
    );
    await mkdir(dirname(endpointPath), { mode: 0o700, recursive: true });
    await chmod(dirname(endpointPath), 0o700);
    const attachment = { descriptor, endpointPath };
    attachments.set(descriptor.peerIdentifier, attachment);
    return attachment;
  },
  async release(descriptor) {
    const attachment = attachments.get(descriptor.peerIdentifier);
    if (attachment !== undefined) {
      await rm(attachment.endpointPath, { force: true });
      attachments.delete(descriptor.peerIdentifier);
    }
  },
};
const firstRuntimePath = `${process.env.CAISSON_FIRECRACKER_RUNTIME_DIR}/${spec.id}`;
let first;
let firstPrepared;
let restored;
let restoredPrepared;
try {
  console.log("START prepare: driver will allocate transport and configure Firecracker");
  firstPrepared = await driver.prepare(spec, transportHost);
  first = firstPrepared.handle;
  console.log("PASS prepare", JSON.stringify(firstPrepared.transport));
  await driver.start(first);
  console.log("PASS start");

  const firstExec = await driver.exec(first, { argv: ["/bin/echo", "hello"] });
  console.log("PASS exec", JSON.stringify(firstExec));
  if (firstExec.exitCode !== 0 || firstExec.stdout !== "hello\n") {
    throw new CaissonError("SANDBOX_FAILED", "exec result did not match expected echo output");
  }

  const snapshot = await driver.snapshot(first, "base");
  console.log("PASS snapshot", JSON.stringify(snapshot));
  await driver.destroy(first);
  await transportHost.release(firstPrepared.transport);
  first = undefined;
  firstPrepared = undefined;
  console.log("PASS destroy source");

  restoredPrepared = await driver.restore(snapshot, { ...spec, id: randomUUID() }, transportHost);
  restored = restoredPrepared.handle;
  await driver.start(restored);
  console.log("PASS restore");
  const restoredExec = await driver.exec(restored, { argv: ["/bin/echo", "hello"] });
  console.log("PASS restored exec", JSON.stringify(restoredExec));
  if (restoredExec.exitCode !== 0 || restoredExec.stdout !== "hello\n") {
    throw new CaissonError(
      "SANDBOX_FAILED",
      "restored exec result did not match expected echo output",
    );
  }
  await driver.destroy(restored);
  await transportHost.release(restoredPrepared.transport);
  restored = undefined;
  restoredPrepared = undefined;
  console.log("PASS destroy restored");
} catch (error) {
  console.error("FAIL Firecracker manual integration", error);
  console.error(`Failure artifacts, if retained: ${firstRuntimePath}`);
  console.error(`Firecracker log, if retained: ${firstRuntimePath}/firecracker.log`);
  process.exitCode = 1;
} finally {
  await Promise.all([
    first === undefined
      ? Promise.resolve()
      : driver.destroy(first).then(() => transportHost.release(firstPrepared.transport)),
    restored === undefined
      ? Promise.resolve()
      : driver.destroy(restored).then(() => transportHost.release(restoredPrepared.transport)),
  ]);
}
