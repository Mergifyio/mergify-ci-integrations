import { type Span, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitTestCaseSpan, endSessionSpan, startSessionSpan } from '../src/spans.js';
import type { TestCaseResult } from '../src/types.js';

function createHarness() {
  const exporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = tracerProvider.getTracer('test');
  return {
    exporter,
    tracing: { tracer, tracerProvider, exporter, resource: undefined!, ownsExporter: false },
  };
}

function baseResult(overrides: Partial<TestCaseResult> = {}): TestCaseResult {
  return {
    filepath: 'a/b.test.ts',
    absoluteFilepath: '/root/a/b.test.ts',
    function: 'test name',
    lineno: 10,
    namespace: 'suite',
    scope: 'case',
    status: 'passed',
    duration: 12,
    startTime: 1000,
    retryCount: 0,
    flaky: false,
    ...overrides,
  };
}

describe('startSessionSpan', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts a span with test.scope=session and the given name', () => {
    const h = createHarness();
    const sessionSpan = startSessionSpan(h.tracing as never, 'playwright session start');
    sessionSpan.end();
    const spans = h.exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('playwright session start');
    expect(spans[0].attributes['test.scope']).toBe('session');
  });

  it('uses MERGIFY_TRACEPARENT when set', () => {
    vi.stubEnv('MERGIFY_TRACEPARENT', '00-11111111111111111111111111111111-2222222222222222-01');
    const h = createHarness();
    const sessionSpan = startSessionSpan(h.tracing as never, 'session');
    sessionSpan.end();
    const spans = h.exporter.getFinishedSpans();
    expect(spans[0].parentSpanContext?.traceId).toBe('11111111111111111111111111111111');
    expect(spans[0].parentSpanContext?.spanId).toBe('2222222222222222');
  });
});

describe('emitTestCaseSpan', () => {
  function run(cb: (sessionSpan: Span, h: ReturnType<typeof createHarness>) => void) {
    const h = createHarness();
    const sessionSpan = h.tracing.tracer.startSpan('s');
    cb(sessionSpan, h);
    sessionSpan.end();
    return h.exporter.getFinishedSpans();
  }

  it('emits basic code and test attributes for a passing test', () => {
    const spans = run((sessionSpan, h) => {
      emitTestCaseSpan(h.tracing.tracer, sessionSpan, baseResult());
    });
    const tc = spans.find((s) => s.attributes['test.scope'] === 'case')!;
    expect(tc.attributes['code.filepath']).toBe('a/b.test.ts');
    expect(tc.attributes['code.function']).toBe('test name');
    expect(tc.attributes['code.lineno']).toBe(10);
    expect(tc.attributes['code.namespace']).toBe('suite');
    expect(tc.attributes['code.file.path']).toBe('/root/a/b.test.ts');
    expect(tc.attributes['code.line.number']).toBe(10);
    expect(tc.attributes['test.case.result.status']).toBe('passed');
    expect(tc.attributes['cicd.test.retry_count']).toBe(0);
    expect(tc.status.code).toBe(SpanStatusCode.OK);
  });

  it('emits exception attributes and ERROR status on failure', () => {
    const spans = run((sessionSpan, h) => {
      emitTestCaseSpan(
        h.tracing.tracer,
        sessionSpan,
        baseResult({
          status: 'failed',
          error: { type: 'AssertionError', message: 'boom', stacktrace: 'at ...' },
        })
      );
    });
    const tc = spans.find((s) => s.attributes['test.scope'] === 'case')!;
    expect(tc.attributes['exception.type']).toBe('AssertionError');
    expect(tc.attributes['exception.message']).toBe('boom');
    expect(tc.attributes['exception.stacktrace']).toBe('at ...');
    expect(tc.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('emits cicd.test.project only when project is set', () => {
    const withProject = run((sessionSpan, h) => {
      emitTestCaseSpan(h.tracing.tracer, sessionSpan, baseResult({ project: 'chromium' }));
    }).find((s) => s.attributes['test.scope'] === 'case')!;
    expect(withProject.attributes['cicd.test.project']).toBe('chromium');

    const noProject = run((sessionSpan, h) => {
      emitTestCaseSpan(h.tracing.tracer, sessionSpan, baseResult());
    }).find((s) => s.attributes['test.scope'] === 'case')!;
    expect(noProject.attributes['cicd.test.project']).toBeUndefined();
  });

  it('emits cicd.test.quarantined only when quarantined is set (true or false)', () => {
    const quarantinedTrue = run((sessionSpan, h) => {
      emitTestCaseSpan(h.tracing.tracer, sessionSpan, baseResult({ quarantined: true }));
    }).find((s) => s.attributes['test.scope'] === 'case')!;
    expect(quarantinedTrue.attributes['cicd.test.quarantined']).toBe(true);

    const quarantinedFalse = run((sessionSpan, h) => {
      emitTestCaseSpan(h.tracing.tracer, sessionSpan, baseResult({ quarantined: false }));
    }).find((s) => s.attributes['test.scope'] === 'case')!;
    expect(quarantinedFalse.attributes['cicd.test.quarantined']).toBe(false);

    const unset = run((sessionSpan, h) => {
      emitTestCaseSpan(h.tracing.tracer, sessionSpan, baseResult());
    }).find((s) => s.attributes['test.scope'] === 'case')!;
    expect(unset.attributes['cicd.test.quarantined']).toBeUndefined();
  });

  it('emits flaky-detection attributes when flakyDetection is set', () => {
    const spans = run((sessionSpan, h) => {
      emitTestCaseSpan(
        h.tracing.tracer,
        sessionSpan,
        baseResult({
          flakyDetection: { new: true, flaky: true, rerunCount: 3 },
        })
      );
    });
    const tc = spans.find((s) => s.attributes['test.scope'] === 'case')!;
    expect(tc.attributes['cicd.test.flaky_detection']).toBe(true);
    expect(tc.attributes['cicd.test.new']).toBe(true);
    expect(tc.attributes['cicd.test.flaky']).toBe(true);
    expect(tc.attributes['cicd.test.rerun_count']).toBe(3);
  });

  it('sets start/end times from result.startTime and result.duration', () => {
    const spans = run((sessionSpan, h) => {
      emitTestCaseSpan(
        h.tracing.tracer,
        sessionSpan,
        baseResult({ startTime: 1_000_000, duration: 250 })
      );
    });
    const tc = spans.find((s) => s.attributes['test.scope'] === 'case')!;
    const startMs = tc.startTime[0] * 1_000 + tc.startTime[1] / 1_000_000;
    const endMs = tc.endTime[0] * 1_000 + tc.endTime[1] / 1_000_000;
    expect(Math.round(startMs)).toBe(1_000_000);
    expect(Math.round(endMs - startMs)).toBe(250);
  });

  it('is a child of the given session span', () => {
    const h = createHarness();
    const sessionSpan = h.tracing.tracer.startSpan('s');
    emitTestCaseSpan(h.tracing.tracer, sessionSpan, baseResult());
    sessionSpan.end();
    const spans = h.exporter.getFinishedSpans();
    const tc = spans.find((s) => s.attributes['test.scope'] === 'case')!;
    const session = spans.find((s) => s.name === 's')!;
    expect(tc.parentSpanContext?.spanId).toBe(session.spanContext().spanId);
  });
});

describe('endSessionSpan', () => {
  it('sets OK on passed and ERROR on failed, and flushes', async () => {
    const h = createHarness();
    const passed = h.tracing.tracer.startSpan('s');
    await endSessionSpan(h.tracing as never, passed, 'passed');
    const failedHarness = createHarness();
    const failed = failedHarness.tracing.tracer.startSpan('s');
    await endSessionSpan(failedHarness.tracing as never, failed, 'failed');

    expect(h.exporter.getFinishedSpans()[0].status.code).toBe(SpanStatusCode.OK);
    expect(failedHarness.exporter.getFinishedSpans()[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it('propagates forceFlush errors while still attempting shutdown', async () => {
    const h = createHarness();
    const span = h.tracing.tracer.startSpan('s');
    const flushError = new Error('flush failed');
    let shutdownCalled = false;

    const tracing = {
      ...h.tracing,
      ownsExporter: true,
      tracerProvider: {
        forceFlush: () => Promise.reject(flushError),
        shutdown: () => {
          shutdownCalled = true;
          return Promise.resolve();
        },
      },
    };

    await expect(endSessionSpan(tracing as never, span, 'passed')).rejects.toBe(flushError);
    expect(shutdownCalled).toBe(true);
  });
});
