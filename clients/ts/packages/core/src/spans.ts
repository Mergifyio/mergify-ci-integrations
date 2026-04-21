import { context, type Span, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { TracingContext } from './tracing.js';
import type { TestCaseResult } from './types.js';

export function startSessionSpan(tracing: TracingContext, name: string): Span {
  let parentContext = context.active();

  const traceparent = process.env.MERGIFY_TRACEPARENT;
  if (traceparent) {
    const carrier = { traceparent };
    const propagator = new W3CTraceContextPropagator();
    parentContext = propagator.extract(context.active(), carrier, {
      get(c: Record<string, string>, key: string) {
        return c[key];
      },
      keys(c: Record<string, string>) {
        return Object.keys(c);
      },
    });
  }

  return tracing.tracer.startSpan(name, { attributes: { 'test.scope': 'session' } }, parentContext);
}

export async function endSessionSpan(
  tracing: TracingContext,
  sessionSpan: Span,
  reason: 'passed' | 'failed' | 'interrupted'
): Promise<void> {
  sessionSpan.setStatus({
    code: reason === 'failed' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
  });
  sessionSpan.end();

  let flushError: unknown;
  try {
    await tracing.tracerProvider.forceFlush();
  } catch (err) {
    flushError = err;
  }

  if (tracing.ownsExporter) {
    try {
      await tracing.tracerProvider.shutdown();
    } catch {
      // ignore shutdown errors
    }
  }

  if (flushError !== undefined) {
    throw flushError;
  }
}

export function emitTestCaseSpan(tracer: Tracer, sessionSpan: Span, result: TestCaseResult): void {
  const parentCtx = trace.setSpan(context.active(), sessionSpan);
  const startTimeMs = result.startTime;
  const endTimeMs = startTimeMs + result.duration;

  const attributes: Record<string, string | number | boolean> = {
    'code.filepath': result.filepath,
    'code.function': result.function,
    'code.lineno': result.lineno,
    'code.namespace': result.namespace,
    'code.file.path': result.absoluteFilepath,
    'code.line.number': result.lineno,
    'test.scope': 'case',
    'test.case.result.status': result.status,
    'cicd.test.retry_count': result.retryCount,
  };

  if (result.project !== undefined) {
    attributes['cicd.test.project'] = result.project;
  }

  if (result.quarantined !== undefined) {
    attributes['cicd.test.quarantined'] = result.quarantined;
  }

  if (result.flakyDetection) {
    attributes['cicd.test.flaky_detection'] = true;
    attributes['cicd.test.new'] = result.flakyDetection.new;
    attributes['cicd.test.flaky'] = result.flakyDetection.flaky;
    attributes['cicd.test.rerun_count'] = result.flakyDetection.rerunCount;
  }

  const spanName =
    result.namespace.length > 0 ? `${result.namespace} > ${result.function}` : result.function;

  const span = tracer.startSpan(spanName, { attributes, startTime: startTimeMs }, parentCtx);

  if (result.error) {
    span.setAttributes({
      'exception.type': result.error.type,
      'exception.message': result.error.message,
      'exception.stacktrace': result.error.stacktrace,
    });
  }

  span.setStatus({
    code: result.status === 'failed' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
  });

  span.end(endTimeMs);
}
