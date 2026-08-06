import type { Span } from '@mergifyio/ci-native';
import { msToUnixNano, newSpanId } from './trace-context.js';
import { type TracingContext, toAttributeList } from './tracing.js';
import type { SpanAttributes, TestCaseResult } from './types.js';

/** The run's root span, open until the session ends. */
export interface SessionSpan {
  traceId: string;
  spanId: string;
  name: string;
  startUnixNano: bigint;
}

export function startSessionSpan(tracing: TracingContext, name: string): SessionSpan {
  return {
    traceId: tracing.traceId,
    spanId: newSpanId(),
    name,
    startUnixNano: msToUnixNano(Date.now()),
  };
}

/**
 * Close the session span and upload the run's trace.
 *
 * The upload is the last thing a run does, so a failure is surfaced rather
 * than swallowed — the reporters decide how loudly to report it.
 */
export async function endSessionSpan(
  tracing: TracingContext,
  sessionSpan: SessionSpan,
  reason: 'passed' | 'failed' | 'interrupted'
): Promise<void> {
  tracing.finished.push({
    name: sessionSpan.name,
    traceId: sessionSpan.traceId,
    spanId: sessionSpan.spanId,
    parentSpanId: tracing.remoteParentSpanId,
    startUnixNano: sessionSpan.startUnixNano,
    endUnixNano: msToUnixNano(Date.now()),
    attributes: toAttributeList({ 'test.scope': 'session' }),
    status: reason === 'failed' ? 'error' : 'ok',
  });

  const spans = tracing.finished;
  tracing.finished = [];
  await tracing.sink.export(toAttributeList(tracing.resourceAttributes), spans);
}

export function emitTestCaseSpan(
  tracing: TracingContext,
  sessionSpan: SessionSpan,
  result: TestCaseResult
): void {
  const attributes: SpanAttributes = {
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

  if (result.error) {
    attributes['exception.type'] = result.error.type;
    attributes['exception.message'] = result.error.message;
    attributes['exception.stacktrace'] = result.error.stacktrace;
  }

  const base =
    result.namespace.length > 0 ? `${result.namespace} > ${result.function}` : result.function;

  const span: Span = {
    name: (result.namePrefix ?? '') + base,
    traceId: sessionSpan.traceId,
    spanId: newSpanId(),
    parentSpanId: sessionSpan.spanId,
    startUnixNano: msToUnixNano(result.startTime),
    endUnixNano: msToUnixNano(result.startTime + result.duration),
    attributes: toAttributeList(attributes),
    status: result.status === 'failed' ? 'error' : 'ok',
  };

  tracing.finished.push(span);
}
