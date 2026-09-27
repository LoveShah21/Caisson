/**
 * INV-7. No persistence across sessions.
 * Sandbox disk and memory are destroyed at termination. Nothing written by one
 * session is observable by another restored from the same base snapshot.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ContainerDriver } from "../../packages/isolation/src/index.js";
import { TestTransportHost } from "../helpers/transport-host.js";

const handles: Array<{
  driver: ContainerDriver;
  prepared: Awaited<ReturnType<ContainerDriver["prepare"]>>;
  transportHost: TestTransportHost;
}> = [];

afterEach(async () => {
  await Promise.all(
    handles.splice(0).map(async ({ driver, prepared, transportHost }) => {
      await transportHost.destroyAndRelease(driver, prepared);
    }),
  );
});

describe("INV-7: no persistence across sessions", () => {
  it("destroys a session workspace before a new session starts", async () => {
    const driver = new ContainerDriver();
    const transportHost = new TestTransportHost();
    const marker = `caisson-inv7-${randomUUID()}`;

    const firstPrepared = await driver.prepare(
      {
        id: randomUUID(),
        image: "alpine:3.23.3",
      },
      transportHost,
    );
    await driver.start(firstPrepared.handle);
    const first = firstPrepared.handle;
    handles.push({ driver, prepared: firstPrepared, transportHost });

    await driver.exec(first, {
      argv: ["/bin/sh", "-c", `printf %s ${marker} > /workspace/marker`],
    });

    await transportHost.destroyAndRelease(driver, firstPrepared);
    handles.splice(
      handles.findIndex(({ prepared }) => prepared.handle.id === first.id),
      1,
    );

    const secondPrepared = await driver.prepare(
      {
        id: randomUUID(),
        image: "alpine:3.23.3",
      },
      transportHost,
    );
    await driver.start(secondPrepared.handle);
    const second = secondPrepared.handle;
    handles.push({ driver, prepared: secondPrepared, transportHost });

    const result = await driver.exec(second, {
      argv: ["/bin/sh", "-c", "test ! -e /workspace/marker"],
    });

    expect(result.exitCode).toBe(0);
  }, 60_000);
});
