import { HttpAdapter, type PinnedHttpTransport } from "../../apps/broker/src/http-adapter.js";
import { describe, expect, it } from "vitest";

const context = { timeoutMs: 1_000 };
const config = {
  allowlist: [{ host: "api.example.test", pathPrefix: "/v1" }],
  allowedPorts: [443],
  timeoutMs: 500,
  requestSizeBytes: 32,
  responseSizeBytes: 32,
};

describe("HttpAdapter", () => {
  it.each([
    ["GET", "http.read"],
    ["HEAD", "http.read"],
    ["OPTIONS", "http.read"],
    ["POST", "http.write"],
    ["PUT", "http.write"],
    ["PATCH", "http.write"],
    ["DELETE", "http.write"],
  ])("maps %s to %s", (method, scope) => {
    const adapter = new HttpAdapter(config, {
      resolve: publicResolver,
      transport: successTransport(),
    });
    expect(
      adapter.methods.request.scopeRequired({ url: "https://api.example.test/v1/a", method }),
    ).toBe(scope);
  });

  it("rejects unsupported HTTP methods", () => {
    const adapter = new HttpAdapter(config, {
      resolve: publicResolver,
      transport: successTransport(),
    });
    expect(() =>
      adapter.methods.request.scopeRequired({
        url: "https://api.example.test/v1/a",
        method: "TRACE",
      }),
    ).toThrow("HTTP method is not permitted");
  });

  it("uses a single resolved public address for the connection and preserves hostname TLS metadata", async () => {
    let resolutions = 0;
    const transport = recordingTransport();
    const adapter = new HttpAdapter(config, {
      resolve: async () => {
        resolutions += 1;
        if (resolutions > 1) throw new Error("resolver was called after validation");
        return ["203.0.113.8"];
      },
      transport,
    });
    await adapter.methods.request.execute(
      undefined,
      { url: "https://api.example.test/v1/items?x=1", method: "GET" },
      context,
    );
    expect(resolutions).toBe(1);
    expect(transport.requests).toEqual([
      expect.objectContaining({
        address: "203.0.113.8",
        host: "api.example.test",
        port: 443,
        path: "/v1/items?x=1",
      }),
    ]);
  });

  it.each([
    ["IPv4-mapped IPv6", "::ffff:127.0.0.1"],
    ["loopback", "127.0.0.1"],
    ["unspecified IPv4", "0.0.0.0"],
    ["CGNAT", "100.64.0.1"],
    ["IPv4 metadata", "169.254.169.254"],
    ["IPv6 metadata", "fe80::a9fe:a9fe"],
    ["unique-local IPv6", "fc00::1"],
  ])("rejects %s resolver address", async (_name, address) => {
    const adapter = new HttpAdapter(config, {
      resolve: async () => [address],
      transport: successTransport(),
    });
    await expect(
      adapter.methods.request.execute(
        undefined,
        { url: "https://api.example.test/v1/a", method: "GET" },
        context,
      ),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });

  it.each([
    "http://api.example.test/v1/a",
    "https://user:password@api.example.test/v1/a",
    "https://api.example.test/other",
    "https://api.example.test:8443/v1/a",
    "https://localhost/v1/a",
    "https://127.0.0.1/v1/a",
    "https://2130706433/v1/a",
    "https://0177.0.0.1/v1/a",
    "https://0x7f000001/v1/a",
  ])("rejects disallowed URL %s", async (url) => {
    const adapter = new HttpAdapter(config, {
      resolve: publicResolver,
      transport: successTransport(),
    });
    await expect(
      adapter.methods.request.execute(undefined, { url, method: "GET" }, context),
    ).rejects.toMatchObject({
      code: "SCOPE_DENIED",
    });
  });

  it.each(["Host", "Authorization", "host", "authorization"])(
    "rejects guest-supplied %s headers",
    async (header) => {
      const adapter = new HttpAdapter(config, {
        resolve: publicResolver,
        transport: successTransport(),
      });
      await expect(
        adapter.methods.request.execute(
          undefined,
          {
            url: "https://api.example.test/v1/a",
            method: "GET",
            headers: { [header]: "forbidden" },
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "PARAMS_INVALID" });
    },
  );

  it("rejects redirects", async () => {
    const adapter = new HttpAdapter(config, {
      resolve: publicResolver,
      transport: successTransport({
        status: 302,
        headers: { location: "https://elsewhere.test" },
        body: Buffer.alloc(0),
      }),
    });
    await expect(
      adapter.methods.request.execute(
        undefined,
        { url: "https://api.example.test/v1/a", method: "GET" },
        context,
      ),
    ).rejects.toMatchObject({ code: "SERVICE_ERROR" });
  });

  it("uses explicit binary envelopes and applies the response limit before base64 encoding", async () => {
    const adapter = new HttpAdapter(config, {
      resolve: publicResolver,
      transport: successTransport({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from([0, 255]),
      }),
    });
    await expect(
      adapter.methods.request.execute(
        undefined,
        {
          url: "https://api.example.test/v1/a",
          method: "POST",
          body: { encoding: "base64", data: "AP8=" },
        },
        context,
      ),
    ).resolves.toEqual({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: { encoding: "base64", data: "AP8=" },
    });

    const oversized = new HttpAdapter(config, {
      resolve: publicResolver,
      transport: successTransport({ status: 200, headers: {}, body: Buffer.alloc(33) }),
    });
    await expect(
      oversized.methods.request.execute(
        undefined,
        { url: "https://api.example.test/v1/a", method: "GET" },
        context,
      ),
    ).rejects.toMatchObject({ code: "SERVICE_ERROR" });
  });
});

function publicResolver(): Promise<readonly string[]> {
  return Promise.resolve(["203.0.113.8"]);
}

function successTransport(
  response = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from("{}"),
  },
): PinnedHttpTransport {
  return { request: async () => response };
}

function recordingTransport(): PinnedHttpTransport & {
  readonly requests: Record<string, unknown>[];
} {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    request: async (input) => {
      requests.push(input);
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    },
  };
}
