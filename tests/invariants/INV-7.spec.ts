/**
 * INV-7. No persistence across sessions.
 * Sandbox disk and memory are destroyed at termination. Nothing written by one
 * session is observable by another restored from the same base snapshot.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ContainerDriver } from "../../packages/isolation/src/index.js";

const handles: Array<{ driver: ContainerDriver; id: string }> = [];

afterEach(async () => {
  await Promise.all(
    handles.splice(0).map(async ({ driver, id }) => {
      await driver.destroy({ id, driver: "container" });
    }),
  );
});

describe("INV-7: no persistence across sessions", () => {
  it("destroys a session workspace before a new session starts", async () => {
    const driver = new ContainerDriver();
    const marker = `caisson-inv7-${randomUUID()}`;

    const first = await driver.create({
      id: randomUUID(),
      image: "alpine:3.23.3",
    });
    handles.push({ driver, id: first.id });

    await driver.exec(first, {
      argv: ["/bin/sh", "-c", `printf %s ${marker} > /workspace/marker`],
    });

    await driver.destroy(first);
    handles.splice(
      handles.findIndex(({ id }) => id === first.id),
      1,
    );

    const second = await driver.create({
      id: randomUUID(),
      image: "alpine:3.23.3",
    });
    handles.push({ driver, id: second.id });

    const result = await driver.exec(second, {
      argv: ["/bin/sh", "-c", "test ! -e /workspace/marker"],
    });

    expect(result.exitCode).toBe(0);
  }, 60_000);
});
