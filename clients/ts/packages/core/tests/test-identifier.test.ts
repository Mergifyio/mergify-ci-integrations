import { describe, expect, it } from 'vitest';
import { emitTestCaseSpan, endSessionSpan, startSessionSpan } from '../src/spans.js';
import { buildTestIdentifier, TEST_NAME_SEPARATOR } from '../src/test-identifier.js';
import { createTracing, InMemorySpanSink, type TracingContext } from '../src/tracing.js';
import type { TestCaseResult } from '../src/types.js';

describe('buildTestIdentifier', () => {
  it('joins the suite chain and the test name', () => {
    expect(buildTestIdentifier('outer > inner', 'passes')).toBe('outer > inner > passes');
  });

  it('is the bare name for a test with no parent suite', () => {
    expect(buildTestIdentifier('', 'passes')).toBe('passes');
  });

  it('never prefixes a file path', () => {
    // The shape the server serves back carries no file. A helper that added one
    // would make every served name unmatchable — the defect this exists to stop.
    expect(buildTestIdentifier('math', 'adds')).not.toContain('.test.');
  });

  it('exposes the separator it uses, so callers cannot pick another', () => {
    expect(buildTestIdentifier('a', 'b')).toBe(`a${TEST_NAME_SEPARATOR}b`);
  });
});

describe('the uploaded span name goes through buildTestIdentifier', () => {
  /** The name actually handed to the sink, read back off the emitted span. */
  async function spanNameFor(namespace: string, fn: string): Promise<string> {
    const sink = new InMemorySpanSink();
    const tracing = createTracing({
      apiClient: null,
      testRunId: 'run-1',
      frameworkAttributes: {},
      sink,
    }) as TracingContext;

    const result: TestCaseResult = {
      filepath: 'a.test.ts',
      absoluteFilepath: '/a.test.ts',
      function: fn,
      lineno: 1,
      namespace,
      scope: 'case',
      status: 'passed',
      duration: 1,
      startTime: Date.now(),
      retryCount: 0,
      flaky: false,
    };

    const session = startSessionSpan(tracing, 'session');
    emitTestCaseSpan(tracing, session, result);
    // Spans only reach the sink when the session ends.
    await endSessionSpan(tracing, session, 'passed');

    const testCase = sink.getFinishedSpans().find((s) => s.attributes['test.scope'] === 'case');
    return testCase!.name;
  }

  it('uploads exactly what the runner will match against', async () => {
    expect(await spanNameFor('outer > inner', 'passes')).toBe(
      buildTestIdentifier('outer > inner', 'passes')
    );
    expect(await spanNameFor('', 'standalone')).toBe(buildTestIdentifier('', 'standalone'));
  });
});
