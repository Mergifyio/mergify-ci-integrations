import type { Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import type { Resource } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { detectResources } from './resources/index.js';
import { isInCI, splitRepoName } from './utils.js';

export interface TracingConfig {
  token: string | undefined;
  repoName: string | undefined;
  apiUrl: string;
  testRunId: string;
  vitestVersion: string;
  /** Injected exporter — bypasses CI and token checks. */
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

class SynchronousBatchSpanProcessor implements SpanProcessor {
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
  if (process.env.VITEST_MERGIFY_DEBUG) {
    return new ConsoleSpanExporter();
  }

  if (!config.token || !config.repoName) {
    return null;
  }

  const { owner, repo } = splitRepoName(config.repoName);

  return new OTLPTraceExporter({
    url: `${config.apiUrl}/v1/ci/${owner}/repositories/${repo}/traces`,
    headers: { Authorization: `Bearer ${config.token}` },
    compression: 'gzip' as never,
  });
}

export function createTracing(config: TracingConfig): TracingContext | null {
  let exporter: SpanExporter | null;
  let ownsExporter: boolean;

  if (config.exporter) {
    // Injected exporter — skip CI and token checks
    exporter = config.exporter;
    ownsExporter = false;
  } else {
    if (!isInCI()) return null;
    exporter = createExporter(config);
    ownsExporter = true;
  }

  if (!exporter) return null;

  const resource = detectResources(config.vitestVersion, config.testRunId);

  // Use SimpleSpanProcessor for injected/debug exporters (exports on each span end)
  // Use SynchronousBatchSpanProcessor for production (batches and exports on flush)
  const useSimpleProcessor = config.exporter || process.env.VITEST_MERGIFY_DEBUG;
  const processor: SpanProcessor = useSimpleProcessor
    ? new SimpleSpanProcessor(exporter)
    : new SynchronousBatchSpanProcessor(exporter);

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [processor],
  });

  const tracer = tracerProvider.getTracer('@mergifyio/vitest');

  return { tracer, tracerProvider, exporter, resource, ownsExporter };
}
