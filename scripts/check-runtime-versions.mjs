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
if (!/^6\.1\.\d+-\d+\.\d+\.amzn2023\.x86_64$/u.test(values.CAISSON_GUEST_KERNEL_VERSION ?? "")) {
  throw new Error("CAISSON_GUEST_KERNEL_VERSION must pin the approved 6.1 x86_64 artifact");
}
if (values.CAISSON_GUEST_KERNEL_ARCH !== "x86_64") {
  throw new Error("CAISSON_GUEST_KERNEL_ARCH must be x86_64 for the pinned runtime pair");
}

console.log(
  `Runtime pair pinned: Firecracker ${values.CAISSON_FIRECRACKER_VERSION}, kernel ${values.CAISSON_GUEST_KERNEL_VERSION}`,
);
