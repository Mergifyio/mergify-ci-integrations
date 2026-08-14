import { describe, expect, it } from 'vitest';
import { emitTestCaseSpan } from '../src/spans.js';
import { buildTestIdentifier, TEST_NAME_SEPARATOR } from '../src/test-identifier.js';
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
  function spanNameFor(namespace: string, fn: string): string {
    const names: string[] = [];
    const tracer = {
      startSpan(name: string) {
        names.push(name);
        return {
          setAttributes: () => {},
          setStatus: () => {},
          end: () => {},
          spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16) }),
        };
      },
    };
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
    // biome-ignore lint/suspicious/noExplicitAny: a tracer stub, not a real one
    emitTestCaseSpan(tracer as any, { spanContext: () => ({}) } as any, result);
    return names[0];
  }

  it('uploads exactly what the runner will match against', () => {
    expect(spanNameFor('outer > inner', 'passes')).toBe(
      buildTestIdentifier('outer > inner', 'passes')
    );
    expect(spanNameFor('', 'standalone')).toBe(buildTestIdentifier('', 'standalone'));
  });
});
