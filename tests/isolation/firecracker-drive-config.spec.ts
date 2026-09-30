import { describe, expect, it } from "vitest";

import {
  firecrackerRootfsDriveConfig,
  isIneligibleBaseRootfs,
} from "../../packages/isolation/src/firecracker-drive-config.js";

describe("Firecracker rootfs drive configuration", () => {
  it("mounts only the M-1 development probe rootfs writable", () => {
    expect(firecrackerRootfsDriveConfig("/images/m1-dev-probe-rootfs.ext4")).toMatchObject({
      is_read_only: false,
      is_root_device: true,
    });
    expect(firecrackerRootfsDriveConfig("/images/production-rootfs.ext4")).toMatchObject({
      is_read_only: true,
      is_root_device: true,
    });
  });

  it("rejects both development-only rootfs artifacts from base promotion", () => {
    expect(isIneligibleBaseRootfs("/images/m1-dev-probe-rootfs.ext4")).toBe(true);
    expect(isIneligibleBaseRootfs("/images/caisson-runtime-diagnostic-rootfs.ext4")).toBe(true);
    expect(isIneligibleBaseRootfs("/images/caisson-runtime-rootfs.ext4")).toBe(false);
  });
});
