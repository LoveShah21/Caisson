import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile("deploy/runtime-versions.env", "utf8");
const values = Object.fromEntries(
  source
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("=", 2)),
);

if (!/^\d+\.\d+\.\d+$/u.test(values.CAISSON_FIRECRACKER_VERSION ?? "")) {
  throw new Error("CAISSON_FIRECRACKER_VERSION must be an exact semantic version");
}
if (
  values.CAISSON_GUEST_KERNEL_VERSION !== "6.1.167" ||
  values.CAISSON_GUEST_KERNEL_TAG !== "v6.1.167"
) {
  throw new Error("CAISSON_GUEST_KERNEL_VERSION and TAG must pin vanilla kernel.org 6.1.167");
}
if (values.CAISSON_GUEST_KERNEL_ARCH !== "x86_64") {
  throw new Error("CAISSON_GUEST_KERNEL_ARCH must be x86_64 for the pinned runtime pair");
}
for (const [field, expected] of Object.entries({
  CAISSON_GUEST_KERNEL_TAG_OBJECT: "4a0e9ad8b501631cbb55d2efcb08710578cb23f5",
  CAISSON_GUEST_KERNEL_SOURCE_COMMIT: "1989cd3d56e257c783ac75200496a2341b50599c",
  CAISSON_GUEST_KERNEL_SIGNER_FINGERPRINT: "647F28654894E3BD457199BE38DBBDC86092693E",
  CAISSON_GUEST_KERNEL_CONFIG_SHA256:
    "153ca1b40f3312bfb40b7587b471ea548a915f98f480f0d0892a1537957a2147",
  CAISSON_GUEST_KERNEL_SOURCE_ARCHIVE_SHA256:
    "2818053c07976ba4ed5f44deb0f5dc7ae7b0975d7918c313d48d8fe7c4e598cb",
})) {
  if (values[field] !== expected)
    throw new Error(`${field} does not match the verified kernel pin`);
}
const guestConfig = await readFile(
  "guest/kernel/firecracker-v1.17.0-microvm-kernel-ci-x86_64-6.1.config",
);
if (
  createHash("sha256").update(guestConfig).digest("hex") !==
  values.CAISSON_GUEST_KERNEL_CONFIG_SHA256
) {
  throw new Error("checked-in Firecracker guest config does not match its pinned SHA-256");
}
const configText = guestConfig.toString("utf8");
for (const required of [
  "CONFIG_SECURITY_LANDLOCK=y",
  'CONFIG_LSM="landlock,lockdown,yama,loadpin,safesetid,integrity,selinux,smack,tomoyo,apparmor,bpf"',
  "CONFIG_VIRTIO_MMIO=y",
  "CONFIG_VIRTIO_BLK=y",
  "CONFIG_VIRTIO_VSOCKETS=y",
  "CONFIG_EXT4_FS=y",
  "CONFIG_SERIAL_8250_CONSOLE=y",
]) {
  if (!configText.split(/\r?\n/u).includes(required)) {
    throw new Error(`checked-in Firecracker guest config is missing ${required}`);
  }
}

console.log(
  `Runtime pair pinned: Firecracker ${values.CAISSON_FIRECRACKER_VERSION}, kernel ${values.CAISSON_GUEST_KERNEL_VERSION}`,
);
