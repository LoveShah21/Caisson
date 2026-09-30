import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { CaissonError } from "@caisson/protocol";
import { z } from "zod";

import { BinaryContentSchema, decodeContent, encodeContent } from "./binary-content.js";
import type { CallContext } from "./postgres-adapter.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const HttpRequestSchema = z
  .object({
    url: z.string().url(),
    method: z.string().min(1).max(16),
    headers: z.record(z.string(), z.string()).optional(),
    body: BinaryContentSchema.optional(),
  })
  .strict();

export interface HttpAllowlistEntry {
  readonly host: string;
  readonly pathPrefix: string;
}

export interface HttpAdapterConfig {
  readonly allowlist: readonly HttpAllowlistEntry[];
  readonly allowedPorts: readonly number[];
  readonly timeoutMs: number;
  readonly requestSizeBytes: number;
  readonly responseSizeBytes: number;
  readonly responseHeaderBytes: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: { readonly encoding: "utf8" | "base64"; readonly data: string };
}

export type ResolvedAddress = string;
export type HostResolver = (host: string) => Promise<readonly ResolvedAddress[]>;

export interface PinnedHttpTransport {
  request(input: {
    readonly address: string;
    readonly host: string;
    readonly port: number;
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Buffer | undefined;
    readonly timeoutMs: number;
    readonly responseSizeBytes: number;
  }): Promise<{
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Buffer;
  }>;
}

export class HttpAdapter {
  readonly name = "http";
  readonly #config: HttpAdapterConfig;
  readonly #resolve: HostResolver;
  readonly #transport: PinnedHttpTransport;

  constructor(
    config: HttpAdapterConfig,
    options: { readonly resolve?: HostResolver; readonly transport?: PinnedHttpTransport } = {},
  ) {
    assertConfig(config);
    this.#config = config;
    this.#resolve = options.resolve ?? resolveHost;
    this.#transport = options.transport ?? new NodePinnedHttpTransport();
  }

  readonly methods = {
    request: {
      params: HttpRequestSchema,
      scopeRequired: (params: unknown): "http.read" | "http.write" => requiredScope(params),
      sideEffecting: (params: unknown): boolean => requiredScope(params) === "http.write",
      summarise: (): string => "make an allowlisted HTTP request",
      execute: async (
        _credentials: undefined,
        params: unknown,
        context: CallContext,
      ): Promise<HttpResponse> => this.#execute(params, context),
    },
  } as const;

  async #execute(params: unknown, context: CallContext): Promise<HttpResponse> {
    const input = HttpRequestSchema.safeParse(params);
    if (!input.success) throw new CaissonError("PARAMS_INVALID", "invalid HTTP request parameters");
    requiredScope(input.data);
    if (!Number.isSafeInteger(context.timeoutMs) || context.timeoutMs <= 0) {
      throw new CaissonError("SERVICE_TIMEOUT", "HTTP timeout must be positive");
    }
    const url = assertAllowlistedUrl(input.data.url, this.#config);
    const headers = sanitizeHeaders(input.data.headers);
    const body =
      input.data.body === undefined
        ? undefined
        : decodeContent(input.data.body, this.#config.requestSizeBytes);
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.#resolve(url.hostname);
    } catch (error: unknown) {
      if (error instanceof CaissonError) throw error;
      throw new CaissonError("SERVICE_ERROR", "HTTP name resolution failed");
    }
    if (addresses.length === 0 || addresses.some(isForbiddenAddress)) {
      throw new CaissonError("SCOPE_DENIED", "HTTP destination address is not permitted");
    }
    let response: Awaited<ReturnType<PinnedHttpTransport["request"]>>;
    try {
      response = await this.#transport.request({
        address: addresses[0] as string,
        host: url.hostname,
        port: Number(url.port || "443"),
        method: input.data.method.toUpperCase(),
        path: `${url.pathname}${url.search}`,
        headers,
        body,
        timeoutMs: Math.min(context.timeoutMs, this.#config.timeoutMs),
        responseSizeBytes: this.#config.responseSizeBytes,
      });
    } catch (error: unknown) {
      if (error instanceof CaissonError) throw error;
      throw new CaissonError("SERVICE_ERROR", "HTTP request failed");
    }
    if (response.body.length > this.#config.responseSizeBytes) {
      throw new CaissonError("SERVICE_ERROR", "HTTP response exceeds configured size limit");
    }
    if (serializedHeaderBytes(response.headers) > this.#config.responseHeaderBytes) {
      throw new CaissonError("SERVICE_ERROR", "HTTP response headers exceed configured size limit");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CaissonError("SERVICE_ERROR", "HTTP redirects are not permitted");
    }
    return {
      status: response.status,
      headers: response.headers,
      body: encodeContent(response.body, response.headers["content-type"]),
    };
  }
}

export class NodePinnedHttpTransport implements PinnedHttpTransport {
  async request(input: {
    readonly address: string;
    readonly host: string;
    readonly port: number;
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Buffer | undefined;
    readonly timeoutMs: number;
    readonly responseSizeBytes: number;
  }): Promise<{
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          host: input.address,
          port: input.port,
          servername: input.host,
          method: input.method,
          path: input.path,
          headers: { ...input.headers, host: input.host },
          timeout: input.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > input.responseSizeBytes) {
              response.destroy(
                new CaissonError("SERVICE_ERROR", "HTTP response exceeds configured size limit"),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            const headers = Object.fromEntries(
              Object.entries(response.headers).flatMap(([key, value]) => {
                if (value === undefined) return [];
                return [[key, Array.isArray(value) ? value.join(", ") : String(value)]];
              }),
            );
            resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
        },
      );
      request.once("error", (error: unknown) => {
        if (error instanceof CaissonError) {
          reject(error);
          return;
        }
        reject(new CaissonError("SERVICE_ERROR", "HTTP request failed"));
      });
      request.once("timeout", () => {
        request.destroy(new CaissonError("SERVICE_TIMEOUT", "HTTP request timed out"));
      });
      request.end(input.body);
    });
  }
}

function assertConfig(config: HttpAdapterConfig): void {
  if (config === undefined || config === null || typeof config !== "object") {
    throw new CaissonError("PARAMS_INVALID", "HTTP adapter configuration is required");
  }
  if (config.allowlist.length === 0 || config.allowedPorts.length === 0) {
    throw new CaissonError("PARAMS_INVALID", "HTTP allowlist and ports are required");
  }
  for (const value of [
    config.timeoutMs,
    config.requestSizeBytes,
    config.responseSizeBytes,
    config.responseHeaderBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CaissonError("PARAMS_INVALID", "HTTP adapter limits must be positive integers");
    }
  }
  for (const port of config.allowedPorts) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new CaissonError("PARAMS_INVALID", "HTTP allowed ports must be valid");
    }
  }
  for (const entry of config.allowlist) {
    if (!/^[a-z0-9.-]+$/iu.test(entry.host) || !entry.pathPrefix.startsWith("/")) {
      throw new CaissonError("PARAMS_INVALID", "HTTP allowlist entry is invalid");
    }
  }
}

function serializedHeaderBytes(headers: Readonly<Record<string, string>>): number {
  return Buffer.byteLength(
    Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join(""),
    "utf8",
  );
}

function requiredScope(params: unknown): "http.read" | "http.write" {
  const input = HttpRequestSchema.safeParse(params);
  if (!input.success) throw new CaissonError("PARAMS_INVALID", "invalid HTTP request parameters");
  const method = input.data.method.toUpperCase();
  if (READ_METHODS.has(method)) return "http.read";
  if (WRITE_METHODS.has(method)) return "http.write";
  throw new CaissonError("SCOPE_DENIED", "HTTP method is not permitted");
}

function assertAllowlistedUrl(value: string, config: HttpAdapterConfig): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    isIP(url.hostname)
  ) {
    throw new CaissonError("SCOPE_DENIED", "HTTP destination is not permitted");
  }
  const port = Number(url.port || "443");
  const entry = config.allowlist.find(
    (candidate) =>
      candidate.host.toLowerCase() === url.hostname.toLowerCase() &&
      pathMatches(url.pathname, candidate.pathPrefix),
  );
  if (entry === undefined || !config.allowedPorts.includes(port)) {
    throw new CaissonError("SCOPE_DENIED", "HTTP destination is not allowlisted");
  }
  return url;
}

function pathMatches(pathname: string, prefix: string): boolean {
  if (prefix === "/") return true;
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

function sanitizeHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (headers === undefined) return {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "host" || key.toLowerCase() === "authorization") {
      throw new CaissonError(
        "PARAMS_INVALID",
        "guest-supplied Host and Authorization headers are forbidden",
      );
    }
  }
  return { ...headers };
}

async function resolveHost(host: string): Promise<readonly ResolvedAddress[]> {
  const addresses = await lookup(host, { all: true, verbatim: true });
  return addresses.map((address) => address.address);
}

function isForbiddenAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isForbiddenIpv4(ipv4ToNumber(address));
  if (version !== 6) return true;
  const value = ipv6ToBigInt(address);
  const mapped = value >> 32n === 0xffffn;
  if (mapped) return isForbiddenIpv4(Number(value & 0xffffffffn));
  return (
    value === 0n ||
    value === 1n ||
    hasPrefix(value, 0xfc00n << 112n, 7) ||
    hasPrefix(value, 0xfe80n << 112n, 10)
  );
}

function isForbiddenIpv4(value: number): boolean {
  return [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0a80000, 16],
    [0xe0000000, 4],
  ].some(([network, prefix]) => {
    const mask = (0xffffffff << (32 - (prefix as number))) >>> 0;
    return (value & mask) >>> 0 === (network as number);
  });
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((value, segment) => (value << 8) | Number(segment), 0) >>> 0;
}

function ipv6ToBigInt(address: string): bigint {
  let normalized = address;
  if (normalized.includes(".")) {
    const index = normalized.lastIndexOf(":");
    const ipv4 = ipv4ToNumber(normalized.slice(index + 1));
    normalized = `${normalized.slice(0, index)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const [left = "", right] = normalized.split("::", 2);
  const leftParts = left === "" ? [] : left.split(":");
  const rightParts = right === undefined || right === "" ? [] : right.split(":");
  const parts = [
    ...leftParts,
    ...Array(Math.max(0, 8 - leftParts.length - rightParts.length)).fill("0"),
    ...rightParts,
  ];
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function hasPrefix(value: bigint, network: bigint, prefix: number): boolean {
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (value & mask) === (network & mask);
}
