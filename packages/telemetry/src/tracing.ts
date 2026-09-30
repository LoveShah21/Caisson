import {
  isSpanContextValid,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import type { SpanName } from "./conventions.js";

const INSTRUMENTATION_NAME = "@caisson/telemetry";
const INSTRUMENTATION_VERSION = "0.0.0";
let provider: NodeTracerProvider | undefined;

export function initializeTelemetry(options: { readonly otlpEndpoint?: string } = {}): void {
  if (provider !== undefined) return;
  provider = new NodeTracerProvider({
    spanProcessors:
      options.otlpEndpoint === undefined
        ? []
        : [new BatchSpanProcessor(new OTLPTraceExporter({ url: options.otlpEndpoint }))],
  });
  provider.register();
}

export async function shutdownTelemetry(): Promise<void> {
  const active = provider;
  provider = undefined;
  await active?.shutdown();
}

export function getCaissonTracer(): Tracer {
  return trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
}

/** Returns identifiers only. It never exposes span attributes or error data. */
export function getActiveTraceIdentifiers():
  | { readonly traceId: string; readonly spanId: string }
  | undefined {
  const context = trace.getActiveSpan()?.spanContext();
  if (context === undefined || !isSpanContextValid(context)) return undefined;
  return { traceId: context.traceId, spanId: context.spanId };
}

export async function runInSpan<T>(
  name: SpanName,
  operation: (span: Span) => Promise<T>,
  tracer: Tracer = getCaissonTracer(),
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await operation(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: unknown) {
      // Do not copy an arbitrary error message onto the span. It may contain a secret.
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
