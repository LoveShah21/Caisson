import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  IsolationDriver,
  PreparedSandbox,
  TransportAttachment,
  TransportDescriptor,
  TransportHost,
} from "../../packages/isolation/src/index.js";

export class TestTransportHost implements TransportHost {
  readonly #servers = new Map<string, net.Server>();
  readonly #reserved = new Set<string>();
  readonly #destroyed = new Set<string>();
  readonly #attachments = new Map<string, TransportAttachment>();
  readonly #runtimeDirectory = join(tmpdir(), "caisson-test-transport");

  async reserve(descriptor: TransportDescriptor): Promise<TransportAttachment> {
    this.#reserved.add(descriptor.peerIdentifier);
    const endpointPath =
      descriptor.kind === "unix"
        ? descriptor.peerIdentifier
        : join(this.#runtimeDirectory, `${randomUUID()}.sock`);
    await mkdir(dirname(endpointPath), { mode: 0o700, recursive: true });
    await chmod(dirname(endpointPath), 0o700);
    const attachment = { descriptor, endpointPath };
    this.#attachments.set(descriptor.peerIdentifier, attachment);
    if (descriptor.kind !== "unix") return attachment;
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpointPath, resolve);
    });
    await chmod(endpointPath, 0o600);
    const stat = await lstat(endpointPath);
    if (!stat.isSocket() || (stat.mode & 0o077) !== 0) throw new Error("invalid transport socket");
    this.#servers.set(descriptor.peerIdentifier, server);
    return attachment;
  }

  async release(descriptor: TransportDescriptor): Promise<void> {
    if (
      this.#reserved.has(descriptor.peerIdentifier) &&
      !this.#destroyed.has(descriptor.peerIdentifier)
    ) {
      throw new Error("transport listener cannot be released before sandbox destruction");
    }
    const server = this.#servers.get(descriptor.peerIdentifier);
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await rm(
      this.#attachments.get(descriptor.peerIdentifier)?.endpointPath ?? descriptor.peerIdentifier,
      {
        force: true,
      },
    );
    this.#servers.delete(descriptor.peerIdentifier);
    this.#reserved.delete(descriptor.peerIdentifier);
    this.#destroyed.delete(descriptor.peerIdentifier);
    this.#attachments.delete(descriptor.peerIdentifier);
  }

  async destroyAndRelease(driver: IsolationDriver, prepared: PreparedSandbox): Promise<void> {
    await driver.destroy(prepared.handle);
    this.#destroyed.add(prepared.transport.peerIdentifier);
    await this.release(prepared.transport);
  }
}
