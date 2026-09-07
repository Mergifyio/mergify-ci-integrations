import type { Attribute, Span } from '@mergifyio/ci-native';
import type { MergifyApiClient } from './api.js';
import { detectResources } from './resources/index.js';
import { newTraceId, parseTraceparent } from './trace-context.js';
import type { SpanAttributes, SpanStatus } from './types.js';
import { envToBool } from './utils.js';

/** Where a run's finished spans go when the session ends. */
export interface SpanSink {
  export(resourceAttributes: Attribute[], spans: Span[]): Promise<void>;
}

/** Uploads through the bundled Rust client — the production sink. */
export class ClientSpanSink implements SpanSink {
  constructor(private client: MergifyApiClient) {}

  export(resourceAttributes: Attribute[], spans: Span[]): Promise<void> {
    return this.client.uploadTrace(resourceAttributes, spans);
  }
}

/** `MERGIFY_CI_DEBUG`: dump the trace to stderr instead of uploading it. */
export class ConsoleSpanSink implements SpanSink {
  async export(resourceAttributes: Attribute[], spans: Span[]): Promise<void> {
    // Serialized by hand because `JSON.stringify` throws on the bigint
    // timestamps.
    const resource = Object.fromEntries(resourceAttributes.map((a) => [a.key, a.value]));
    process.stderr.write(`[mergify] resource ${JSON.stringify(resource)}\n`);
    for (const span of spans) {
      process.stderr.write(
        `[mergify] span ${span.name} ${span.status} ${span.spanId}` +
          ` parent=${span.parentSpanId ?? '-'}` +
          ` ${JSON.stringify(Object.fromEntries(span.attributes.map((a) => [a.key, a.value])))}\n`
      );
    }
  }
}

/**
 * A finished span as captured for assertions: identical to the span handed to
 * the binding, except attributes are keyed rather than a list, which is what
 * the behavior suites actually read.
 */
export interface CapturedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startUnixNano: bigint;
  endUnixNano: bigint;
  attributes: SpanAttributes;
  status: SpanStatus;
  statusMessage?: string;
  /** The run's resource attributes, repeated on each span for convenience. */
  resourceAttributes: SpanAttributes;
}

/** Collects spans in memory instead of uploading them. For tests. */
export class InMemorySpanSink implements SpanSink {
  private spans: CapturedSpan[] = [];

  async export(resourceAttributes: Attribute[], spans: Span[]): Promise<void> {
    const resource = keyed(resourceAttributes);
    for (const span of spans) {
      this.spans.push({
        name: span.name,
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId ?? undefined,
        startUnixNano: span.startUnixNano,
        endUnixNano: span.endUnixNano,
        attributes: keyed(span.attributes),
        status: span.status as SpanStatus,
        statusMessage: span.statusMessage ?? undefined,
        resourceAttributes: resource,
      });
    }
  }

  getFinishedSpans(): CapturedSpan[] {
    return this.spans;
  }

  reset(): void {
    this.spans = [];
  }
}

function keyed(attributes: Attribute[]): SpanAttributes {
  return Object.fromEntries(attributes.map((a) => [a.key, a.value]));
}

/** The binding takes a list; the plugins build a record. */
export function toAttributeList(attributes: SpanAttributes): Attribute[] {
  return Object.entries(attributes).map(([key, value]) => ({ key, value }));
}

export interface TracingConfig {
  /**
   * Client the spans are uploaded through; null when there is no token, no
   * detected repository, or no binding for this platform — in which case
   * tracing stays off.
   */
  apiClient: MergifyApiClient | null;
  testRunId: string;
  frameworkAttributes: SpanAttributes;
  /** Injected sink — bypasses the client entirely. */
  sink?: SpanSink;
}

export interface TracingContext {
  sink: SpanSink;
  resourceAttributes: SpanAttributes;
  /** Every span in a run belongs to one trace. */
  traceId: string;
  /** Parent from `MERGIFY_TRACEPARENT`, when the run is part of a wider trace. */
  remoteParentSpanId?: string;
  /** Spans finished so far, uploaded when the session span ends. */
  finished: Span[];
}

function defaultSink(config: TracingConfig): SpanSink | null {
  if (envToBool(process.env.MERGIFY_CI_DEBUG, false)) {
    return new ConsoleSpanSink();
  }
  if (!config.apiClient) {
    return null;
  }
  return new ClientSpanSink(config.apiClient);
}

export function createTracing(config: TracingConfig): TracingContext | null {
  const sink = config.sink ?? defaultSink(config);
  if (!sink) return null;

  // A `MERGIFY_TRACEPARENT` from the surrounding job makes this run a child of
  // that trace; otherwise the session span roots a fresh one.
  const traceparent = process.env.MERGIFY_TRACEPARENT;
  const remote = traceparent ? parseTraceparent(traceparent) : null;

  return {
    sink,
    resourceAttributes: detectResources(config.frameworkAttributes, config.testRunId),
    traceId: remote?.traceId ?? newTraceId(),
    remoteParentSpanId: remote?.parentSpanId,
    finished: [],
  };
}
