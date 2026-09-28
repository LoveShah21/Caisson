import { GenericContainer, Wait } from "testcontainers";

export interface ClickHouseFixture {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  query(query: string): Promise<string>;
  close(): Promise<void>;
}

export async function createClickHouseFixture(): Promise<ClickHouseFixture> {
  const username = "caisson";
  const password = "caisson-clickhouse-test-only";
  const container = await new GenericContainer("clickhouse/clickhouse-server:26.8.3-alpine")
    .withEnvironment({
      CLICKHOUSE_DB: "caisson",
      CLICKHOUSE_USER: username,
      CLICKHOUSE_PASSWORD: password,
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
    })
    .withExposedPorts(8123)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const url = `http://${container.getHost()}:${container.getMappedPort(8123)}`;
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  await waitForClickHouse(url);

  return {
    url,
    username,
    password,
    async query(query: string): Promise<string> {
      const response = await fetch(`${url}/?database=caisson`, {
        method: "POST",
        headers: { authorization },
        body: query,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`ClickHouse request failed with status ${response.status}: ${body}`);
      }
      return body;
    },
    async close(): Promise<void> {
      await container.stop();
    },
  };
}

async function waitForClickHouse(url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${url}/ping`);
      if (response.ok && (await response.text()) === "Ok.\n") {
        return;
      }
    } catch (error: unknown) {
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error("ClickHouse did not become ready");
}
