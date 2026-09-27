import { basename } from "node:path";

const M1_DEV_PROBE_ROOTFS = "m1-dev-probe-rootfs.ext4";

export function firecrackerRootfsDriveConfig(
  rootfsPath: string,
): Readonly<Record<string, unknown>> {
  return {
    drive_id: "rootfs",
    path_on_host: rootfsPath,
    is_root_device: true,
    // The M-1 probe needs a writable root while devtmpfs is mounted.
    // Every non-probe image keeps the original read-only setting.
    is_read_only: basename(rootfsPath) !== M1_DEV_PROBE_ROOTFS,
  };
}

export function isM1DevelopmentProbeRootfs(rootfsPath: string): boolean {
  return basename(rootfsPath) === M1_DEV_PROBE_ROOTFS;
}
