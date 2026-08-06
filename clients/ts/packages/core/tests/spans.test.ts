import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitTestCaseSpan,
  endSessionSpan,
  type SessionSpan,
  startSessionSpan,
} from '../src/spans.js';
import {
  type CapturedSpan,
  createTracing,
  InMemorySpanSink,
  type TracingContext,
} from '../src/tracing.js';
import type { TestCaseResult } from '../src/types.js';

function createHarness() {
  const sink = new InMemorySpanSink();
  const tracing = createTracing({
    apiClient: null,
    testRunId: 'run-1',
    frameworkAttributes: {},
    sink,
  }) as TracingContext;
  return { sink, tracing };
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

/** Spans only reach the sink when the session ends, so every run closes it. */
async function collect(
  emit: (tracing: TracingContext, sessionSpan: SessionSpan) => void,
  reason: 'passed' | 'failed' = 'passed'
): Promise<CapturedSpan[]> {
  const h = createHarness();
  const sessionSpan = startSessionSpan(h.tracing, 's');
  emit(h.tracing, sessionSpan);
  await endSessionSpan(h.tracing, sessionSpan, reason);
  return h.sink.getFinishedSpans();
}

function testCase(spans: CapturedSpan[]): CapturedSpan {
  return spans.find((s) => s.attributes['test.scope'] === 'case') as CapturedSpan;
}

describe('startSessionSpan', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts a span with test.scope=session and the given name', async () => {
    const h = createHarness();
    const sessionSpan = startSessionSpan(h.tracing, 'playwright session start');
    await endSessionSpan(h.tracing, sessionSpan, 'passed');

    const spans = h.sink.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('playwright session start');
    expect(spans[0].attributes['test.scope']).toBe('session');
  });

  it('uses MERGIFY_TRACEPARENT when set', async () => {
    vi.stubEnv('MERGIFY_TRACEPARENT', '00-11111111111111111111111111111111-2222222222222222-01');
    const h = createHarness();
    const sessionSpan = startSessionSpan(h.tracing, 'session');
    await endSessionSpan(h.tracing, sessionSpan, 'passed');

    const spans = h.sink.getFinishedSpans();
    expect(spans[0].traceId).toBe('11111111111111111111111111111111');
    expect(spans[0].parentSpanId).toBe('2222222222222222');
  });

  it('roots a fresh trace when MERGIFY_TRACEPARENT is absent', async () => {
    const h = createHarness();
    const sessionSpan = startSessionSpan(h.tracing, 'session');
    await endSessionSpan(h.tracing, sessionSpan, 'passed');

    const spans = h.sink.getFinishedSpans();
    expect(spans[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0].parentSpanId).toBeUndefined();
  });
});

describe('emitTestCaseSpan', () => {
  it('emits basic code and test attributes for a passing test', async () => {
    const tc = testCase(
      await collect((tracing, session) => emitTestCaseSpan(tracing, session, baseResult()))
    );
    expect(tc.attributes['code.filepath']).toBe('a/b.test.ts');
    expect(tc.attributes['code.function']).toBe('test name');
    expect(tc.attributes['code.lineno']).toBe(10);
    expect(tc.attributes['code.namespace']).toBe('suite');
    expect(tc.attributes['code.file.path']).toBe('/root/a/b.test.ts');
    expect(tc.attributes['code.line.number']).toBe(10);
    expect(tc.attributes['test.case.result.status']).toBe('passed');
    expect(tc.attributes['cicd.test.retry_count']).toBe(0);
    expect(tc.status).toBe('ok');
  });

  it('emits exception attributes and error status on failure', async () => {
    const tc = testCase(
      await collect((tracing, session) =>
        emitTestCaseSpan(
          tracing,
          session,
          baseResult({
            status: 'failed',
            error: { type: 'AssertionError', message: 'boom', stacktrace: 'at ...' },
          })
        )
      )
    );
    expect(tc.attributes['exception.type']).toBe('AssertionError');
    expect(tc.attributes['exception.message']).toBe('boom');
    expect(tc.attributes['exception.stacktrace']).toBe('at ...');
    expect(tc.status).toBe('error');
  });

  it('emits cicd.test.project only when project is set', async () => {
    const withProject = testCase(
      await collect((tracing, session) =>
        emitTestCaseSpan(tracing, session, baseResult({ project: 'chromium' }))
      )
    );
    expect(withProject.attributes['cicd.test.project']).toBe('chromium');

    const noProject = testCase(
      await collect((tracing, session) => emitTestCaseSpan(tracing, session, baseResult()))
    );
    expect(noProject.attributes['cicd.test.project']).toBeUndefined();
  });

  it('emits cicd.test.quarantined only when quarantined is set (true or false)', async () => {
    const quarantinedTrue = testCase(
      await collect((tracing, session) =>
        emitTestCaseSpan(tracing, session, baseResult({ quarantined: true }))
      )
    );
    expect(quarantinedTrue.attributes['cicd.test.quarantined']).toBe(true);

    const quarantinedFalse = testCase(
      await collect((tracing, session) =>
        emitTestCaseSpan(tracing, session, baseResult({ quarantined: false }))
      )
    );
    expect(quarantinedFalse.attributes['cicd.test.quarantined']).toBe(false);

    const unset = testCase(
      await collect((tracing, session) => emitTestCaseSpan(tracing, session, baseResult()))
    );
    expect(unset.attributes['cicd.test.quarantined']).toBeUndefined();
  });

  it('emits flaky-detection attributes when flakyDetection is set', async () => {
    const tc = testCase(
      await collect((tracing, session) =>
        emitTestCaseSpan(
          tracing,
          session,
          baseResult({ flakyDetection: { new: true, flaky: true, rerunCount: 3 } })
        )
      )
    );
    expect(tc.attributes['cicd.test.flaky_detection']).toBe(true);
    expect(tc.attributes['cicd.test.new']).toBe(true);
    expect(tc.attributes['cicd.test.flaky']).toBe(true);
    expect(tc.attributes['cicd.test.rerun_count']).toBe(3);
  });

  it('sets start/end times from result.startTime and result.duration', async () => {
    const tc = testCase(
      await collect((tracing, session) =>
        emitTestCaseSpan(tracing, session, baseResult({ startTime: 1_000_000, duration: 250 }))
      )
    );
    // Milliseconds since the epoch, as nanoseconds.
    expect(tc.startUnixNano).toBe(1_000_000_000_000n);
    expect(tc.endUnixNano - tc.startUnixNano).toBe(250_000_000n);
  });

  it('is a child of the given session span, in the same trace', async () => {
    const spans = await collect((tracing, session) =>
      emitTestCaseSpan(tracing, session, baseResult())
    );
    const tc = testCase(spans);
    const session = spans.find((s) => s.name === 's') as CapturedSpan;
    expect(tc.parentSpanId).toBe(session.spanId);
    expect(tc.traceId).toBe(session.traceId);
  });

  it('prepends namePrefix to the span name only, leaving code.namespace unchanged', async () => {
    const tc = testCase(
      await collect((tracing, session) =>
        emitTestCaseSpan(
          tracing,
          session,
          baseResult({
            namespace: 'tests/x.spec.ts',
            function: 'my test',
            namePrefix: '[chromium] > ',
          })
        )
      )
    );
    expect(tc.name).toBe('[chromium] > tests/x.spec.ts > my test');
    expect(tc.attributes['code.namespace']).toBe('tests/x.spec.ts');
  });

  it('leaves the span name unchanged when namePrefix is absent', async () => {
    const tc = testCase(
      await collect((tracing, session) =>
        emitTestCaseSpan(
          tracing,
          session,
          baseResult({ namespace: 'tests/x.spec.ts', function: 'my test' })
        )
      )
    );
    expect(tc.name).toBe('tests/x.spec.ts > my test');
  });

  it('treats an empty-string namePrefix like an absent one (guards ?? vs ||)', async () => {
    const tc = testCase(
      await collect((tracing, session) =>
        emitTestCaseSpan(
          tracing,
          session,
          baseResult({ namespace: 'tests/x.spec.ts', function: 'my test', namePrefix: '' })
        )
      )
    );
    expect(tc.name).toBe('tests/x.spec.ts > my test');
  });
});

describe('endSessionSpan', () => {
  it('sets ok on passed and error on failed, and uploads', async () => {
    const passed = await collect(() => {}, 'passed');
    const failed = await collect(() => {}, 'failed');

    expect(passed[0].status).toBe('ok');
    expect(failed[0].status).toBe('error');
  });

  it('uploads the whole run in one export, session span last', async () => {
    const spans = await collect((tracing, session) => {
      emitTestCaseSpan(tracing, session, baseResult({ function: 'first' }));
      emitTestCaseSpan(tracing, session, baseResult({ function: 'second' }));
    });
    expect(spans.map((s) => s.name)).toEqual(['suite > first', 'suite > second', 's']);
  });

  it('carries the run resource attributes on the export', async () => {
    const sink = new InMemorySpanSink();
    const tracing = createTracing({
      apiClient: null,
      testRunId: 'run-42',
      frameworkAttributes: { 'test.framework': 'vitest' },
      sink,
    }) as TracingContext;
    const session = startSessionSpan(tracing, 's');
    await endSessionSpan(tracing, session, 'passed');

    const [span] = sink.getFinishedSpans();
    expect(span.resourceAttributes['test.run.id']).toBe('run-42');
    expect(span.resourceAttributes['test.framework']).toBe('vitest');
  });

  it('propagates an upload failure to the caller', async () => {
    const failure = new Error('upload failed');
    const tracing = createTracing({
      apiClient: null,
      testRunId: 'run-1',
      frameworkAttributes: {},
      sink: { export: () => Promise.reject(failure) },
    }) as TracingContext;
    const session = startSessionSpan(tracing, 's');

    await expect(endSessionSpan(tracing, session, 'passed')).rejects.toBe(failure);
  });

  it('does not re-upload spans already handed to the sink', async () => {
    const sink = new InMemorySpanSink();
    const tracing = createTracing({
      apiClient: null,
      testRunId: 'run-1',
      frameworkAttributes: {},
      sink,
    }) as TracingContext;

    const first = startSessionSpan(tracing, 'first');
    emitTestCaseSpan(tracing, first, baseResult());
    await endSessionSpan(tracing, first, 'passed');

    const second = startSessionSpan(tracing, 'second');
    await endSessionSpan(tracing, second, 'passed');

    // The buffer is drained on export, so the second run carries only its own
    // session span — not a replay of the first run's test case.
    expect(sink.getFinishedSpans().map((s) => s.name)).toEqual([
      'suite > test name',
      'first',
      'second',
    ]);
  });
});
