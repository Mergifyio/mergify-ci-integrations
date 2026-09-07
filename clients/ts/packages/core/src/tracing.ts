import type { Attributes, Tracer } from '@opentelemetry/api';
import type { Resource } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { MergifyApiClient } from './api.js';
import { NativeTraceExporter } from './native-exporter.js';
import { detectResources } from './resources/index.js';
import { envToBool } from './utils.js';

export interface TracingConfig {
  /**
   * Client the spans are uploaded through; null when there is no token, no
   * detected repository, or no binding for this platform — in which case
   * tracing stays off.
   */
  apiClient: MergifyApiClient | null;
  testRunId: string;
  frameworkAttributes: Attributes;
  tracerName: string;
  /** Injected exporter — bypasses the client entirely. */
  exporter?: SpanExporter;
}

export interface TracingContext {
  tracer: Tracer;
  tracerProvider: BasicTracerProvider;
  exporter: SpanExporter;
  resource: Resource;
  /** Whether the provider should be shut down on test run end. */
  ownsExporter: boolean;
}

export class SynchronousBatchSpanProcessor implements SpanProcessor {
  private queue: ReadableSpan[] = [];

  constructor(private exporter: SpanExporter) {}

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    if (span.spanContext().traceFlags & 1) {
      this.queue.push(span);
    }
  }

  forceFlush(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.exporter.export(this.queue, (result) => {
        this.queue = [];
        if (result.error) {
          reject(result.error);
        } else {
          resolve();
        }
      });
    });
  }

  shutdown(): Promise<void> {
    return this.forceFlush().then(() => this.exporter.shutdown());
  }
}

function createExporter(config: TracingConfig): SpanExporter | null {
  if (envToBool(process.env.MERGIFY_CI_DEBUG, false)) {
    return new ConsoleSpanExporter();
  }

  if (!config.apiClient) {
    return null;
  }

  return new NativeTraceExporter(config.apiClient);
}

export function createTracing(config: TracingConfig): TracingContext | null {
  let exporter: SpanExporter | null;
  let ownsExporter: boolean;

  if (config.exporter) {
    // Injected exporter — skip CI and token checks
    exporter = config.exporter;
    ownsExporter = false;
  } else {
    exporter = createExporter(config);
    ownsExporter = true;
  }

  if (!exporter) return null;

  const resource = detectResources(config.frameworkAttributes, config.testRunId);

  // Use SimpleSpanProcessor for injected/debug exporters (exports on each span end)
  // Use SynchronousBatchSpanProcessor for production (batches and exports on flush)
  const useSimpleProcessor = config.exporter || envToBool(process.env.MERGIFY_CI_DEBUG, false);
  const processor: SpanProcessor = useSimpleProcessor
    ? new SimpleSpanProcessor(exporter)
    : new SynchronousBatchSpanProcessor(exporter);

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [processor],
  });

  const tracer = tracerProvider.getTracer(config.tracerName);

  return { tracer, tracerProvider, exporter, resource, ownsExporter };
}
