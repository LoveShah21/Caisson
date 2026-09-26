import type { IsolationDriver, SandboxHandle, SandboxSpec } from "@caisson/isolation";
import { ATTRIBUTE_KEYS, runInSpan, SPAN_NAMES } from "@caisson/telemetry";

export async function bootSandbox(
  driver: IsolationDriver,
  spec: SandboxSpec,
  kind: "cold" | "warm",
): Promise<SandboxHandle> {
  const startedAt = performance.now();
  return runInSpan(SPAN_NAMES.sandboxBoot, async (span) => {
    span.setAttribute(
      ATTRIBUTE_KEYS.driver,
      driver.capabilities().hardwareIsolation ? "firecracker" : "container",
    );
    span.setAttribute(ATTRIBUTE_KEYS.bootKind, kind);
    try {
      const handle = await driver.create(spec);
      return handle;
    } finally {
      span.setAttribute(ATTRIBUTE_KEYS.bootMs, Math.round(performance.now() - startedAt));
    }
  });
}
