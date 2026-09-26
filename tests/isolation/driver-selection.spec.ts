import { describe, expect, it, vi } from "vitest";
import {
  ContainerDriver,
  selectIsolationDriver,
  validateIsolationDriverForEnvironment,
} from "../../packages/isolation/src/index.js";

describe("isolation driver selection", () => {
  it("selects the container driver when KVM is unavailable", async () => {
    const container = new ContainerDriver({ warn: vi.fn() });
    const selected = await selectIsolationDriver({
      containerDriver: container,
      kvmAvailable: async () => false,
    });

    expect(selected).toBe(container);
    expect(selected.capabilities()).toMatchObject({ hardwareIsolation: false });
  });

  it("rejects an unisolated driver in production", () => {
    expect(() =>
      validateIsolationDriverForEnvironment(new ContainerDriver({ warn: vi.fn() }), "production"),
    ).toThrow("hardware isolation");
  });
});
