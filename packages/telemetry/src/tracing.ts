import { type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";

import type { SpanName } from "./conventions.js";

const INSTRUMENTATION_NAME = "@caisson/telemetry";
const INSTRUMENTATION_VERSION = "0.0.0";

export function getCaissonTracer(): Tracer {
  return trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
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
