import { access, constants } from "node:fs/promises";

import { CaissonError } from "@caisson/protocol";

import type { ContainerDriver } from "./container-driver.js";
import type { IsolationDriver } from "./types.js";

export interface DriverSelectionOptions {
  readonly containerDriver: ContainerDriver;
  readonly firecrackerDriver?: IsolationDriver;
  readonly kvmAvailable?: () => Promise<boolean>;
}

export async function isKvmAvailable(): Promise<boolean> {
  try {
    await access("/dev/kvm", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function selectIsolationDriver(
  options: DriverSelectionOptions,
): Promise<IsolationDriver> {
  const kvmAvailable = await (options.kvmAvailable ?? isKvmAvailable)();
  if (kvmAvailable) {
    if (options.firecrackerDriver === undefined) {
      throw new CaissonError(
        "SANDBOX_FAILED",
        "KVM is available but no Firecracker driver is configured",
      );
    }
    return options.firecrackerDriver;
  }
  return options.containerDriver;
}

export function validateIsolationDriverForEnvironment(
  driver: IsolationDriver,
  environment: string | undefined,
): void {
  if (environment === "production" && !driver.capabilities().hardwareIsolation) {
    throw new CaissonError(
      "SANDBOX_FAILED",
      "production requires a driver with hardware isolation",
    );
  }
}
