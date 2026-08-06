import type { Attribute, Span } from '@mergifyio/ci-native';
import type { Attributes, HrTime } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { MergifyApiClient } from './api.js';

const NANOS_PER_SECOND = 1_000_000_000n;

/**
 * Exports finished spans through the bundled Rust client, which encodes them
 * as OTLP protobuf, gzips them, splits oversized traces, and retries transient
 * failures — everything `@opentelemetry/exporter-trace-otlp-proto` used to do
 * here, now shared with pytest-mergify.
 *
 * Span *construction* stays on the OpenTelemetry SDK: this only marshals
 * finished spans into the plain data the binding takes, so no live OTel object
 * crosses the boundary.
 */
export class NativeTraceExporter implements SpanExporter {
  constructor(private client: MergifyApiClient) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    // One tracer provider means one resource, so the whole batch shares the
    // first span's — which is how OTLP frames it anyway (resource once, spans
    // beneath it).
    const resource = toAttributes(spans[0].resource.attributes);

    this.client
      .uploadTrace(resource, spans.map(toNativeSpan))
      .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
      .catch((err: unknown) => {
        resultCallback({
          code: ExportResultCode.FAILED,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
  }

  // The client holds no buffered state — each export is a complete upload — so
  // both are no-ops.
  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

/**
 * OTel attribute values are `string | number | boolean` or arrays of those.
 * Arrays are dropped: nothing these plugins emit uses one, and the upload path
 * has no representation for them.
 */
function toAttributes(attributes: Attributes): Attribute[] {
  const out: Attribute[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push({ key, value });
    }
  }
  return out;
}

/** An OTel `[seconds, nanos]` timestamp as nanoseconds since the epoch. */
function toUnixNano(time: HrTime): bigint {
  return BigInt(time[0]) * NANOS_PER_SECOND + BigInt(time[1]);
}

function toNativeSpan(span: ReadableSpan): Span {
  const spanContext = span.spanContext();
  return {
    name: span.name,
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    startUnixNano: toUnixNano(span.startTime),
    endUnixNano: toUnixNano(span.endTime),
    attributes: toAttributes(span.attributes),
    status: statusName(span.status.code),
    statusMessage: span.status.message,
  };
}

function statusName(code: SpanStatusCode): string {
  switch (code) {
    case SpanStatusCode.OK:
      return 'ok';
    case SpanStatusCode.ERROR:
      return 'error';
    default:
      return 'unset';
  }
}
