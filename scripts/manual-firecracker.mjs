import { randomUUID } from "node:crypto";
import { basename } from "node:path";

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
let first;
let restored;
try {
  first = await driver.create(spec);
  console.log("PASS create");

  const firstExec = await driver.exec(first, { argv: ["/bin/echo", "hello"] });
  console.log("PASS exec", JSON.stringify(firstExec));
  if (firstExec.exitCode !== 0 || firstExec.stdout !== "hello\n") {
    throw new CaissonError("SANDBOX_FAILED", "exec result did not match expected echo output");
  }

  const snapshot = await driver.snapshot(first, "base");
  console.log("PASS snapshot", JSON.stringify(snapshot));
  await driver.destroy(first);
  first = undefined;
  console.log("PASS destroy source");

  restored = await driver.restore(snapshot, { ...spec, id: randomUUID() });
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
  restored = undefined;
  console.log("PASS destroy restored");
} catch (error) {
  console.error("FAIL Firecracker manual integration", error);
  process.exitCode = 1;
} finally {
  await Promise.all([
    first === undefined ? Promise.resolve() : driver.destroy(first),
    restored === undefined ? Promise.resolve() : driver.destroy(restored),
  ]);
}
