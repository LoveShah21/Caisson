import type {
  IsolationDriver,
  PreparedSandbox,
  SandboxHandle,
  SandboxSpec,
  TransportDescriptor,
  TransportHost,
} from "@caisson/isolation";
import { ATTRIBUTE_KEYS, runInSpan, SPAN_NAMES } from "@caisson/telemetry";

export async function bootSandbox(
  driver: IsolationDriver,
  spec: SandboxSpec,
  transportHost: TransportHost,
  persistTransport: (descriptor: TransportDescriptor) => Promise<void>,
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
      const prepared = await driver.prepare(spec, transportHost);
      try {
        await persistTransport(prepared.transport);
        await driver.start(prepared.handle);
        return prepared.handle;
      } catch (error: unknown) {
        await destroyPreparedSandbox(driver, prepared, transportHost);
        throw error;
      }
    } finally {
      span.setAttribute(ATTRIBUTE_KEYS.bootMs, Math.round(performance.now() - startedAt));
    }
  });
}

/**
 * Releases a broker-owned listener only after its sandbox is no longer live.
 * Session lifecycle code must use this for prepared sandboxes.
 */
export async function destroyPreparedSandbox(
  driver: IsolationDriver,
  prepared: PreparedSandbox,
  transportHost: TransportHost,
): Promise<void> {
  await driver.destroy(prepared.handle);
  await transportHost.release(prepared.transport);
}
