import { describe, expect, it } from 'vitest';
import { msToUnixNano, newSpanId, newTraceId, parseTraceparent } from '../src/trace-context.js';

// Letters, not just digits — the uppercase-rejection case needs a value that
// actually changes under toUpperCase().
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

describe('parseTraceparent', () => {
  it('parses a well-formed version-00 traceparent', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`)).toEqual({
      traceId: TRACE_ID,
      parentSpanId: SPAN_ID,
    });
  });

  it('accepts trailing fields on a future version', () => {
    // Only version `00` forbids them; later versions may extend the format.
    expect(parseTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-extra`)).toEqual({
      traceId: TRACE_ID,
      parentSpanId: SPAN_ID,
    });
  });

  it('rejects trailing fields on version 00', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01-extra`)).toBeNull();
  });

  it('rejects the reserved ff version', () => {
    expect(parseTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeNull();
  });

  it('rejects wrong id widths', () => {
    expect(parseTraceparent(`00-${TRACE_ID.slice(0, 31)}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID.slice(0, 15)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-0`)).toBeNull();
  });

  it('rejects uppercase and non-hex', () => {
    expect(parseTraceparent(`00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${'g'.repeat(32)}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-zz`)).toBeNull();
  });

  it('rejects all-zero ids', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeNull();
  });

  it('rejects a value with too few fields', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}`)).toBeNull();
    expect(parseTraceparent('')).toBeNull();
  });
});

describe('id generation', () => {
  it('produces lowercase hex ids of the right width', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not repeat', () => {
    expect(newTraceId()).not.toBe(newTraceId());
    expect(newSpanId()).not.toBe(newSpanId());
  });
});

describe('msToUnixNano', () => {
  it('converts whole milliseconds', () => {
    expect(msToUnixNano(1_000_000)).toBe(1_000_000_000_000n);
    expect(msToUnixNano(0)).toBe(0n);
  });

  it('keeps sub-millisecond precision', () => {
    expect(msToUnixNano(1.5)).toBe(1_500_000n);
    expect(msToUnixNano(0.000_001)).toBe(1n);
  });

  it('stays exact past what a JS number could hold in nanoseconds', () => {
    // A realistic epoch timestamp: 1.7e12 ms is 1.7e18 ns, well past 2^53, so
    // the multiply has to happen in BigInt to survive.
    expect(msToUnixNano(1_775_000_000_000)).toBe(1_775_000_000_000_000_000n);
  });
});
