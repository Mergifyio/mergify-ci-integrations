import { randomBytes } from 'node:crypto';

/** A new 16-byte trace id, as lowercase hex. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** A new 8-byte span id, as lowercase hex. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

export interface RemoteParent {
  traceId: string;
  parentSpanId: string;
}

// W3C trace-context is lowercase hex only; an all-zero id is invalid.
const HEX = /^[0-9a-f]+$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

/**
 * Parse a W3C `traceparent` into the trace and parent span ids.
 *
 * Format: `<version>-<32 hex trace id>-<16 hex span id>-<flags>`, all lowercase
 * hex per the spec. A version-`00` traceparent has exactly those four fields; a
 * future version may carry extra trailing ones, which are ignored. A malformed
 * or reserved value — wrong widths, uppercase or non-hex, an all-zero id, or
 * the reserved `ff` version — yields null, so the session starts a fresh,
 * unparented trace.
 *
 * Mirrors the `W3CTraceContextPropagator` this replaced, which rejected the
 * same inputs, and pytest-mergify's `parse_traceparent`, which is the same
 * function in Python.
 */
export function parseTraceparent(traceparent: string): RemoteParent | null {
  const parts = traceparent.split('-');
  if (parts.length < 4) return null;

  const [version, traceId, spanId, flags] = parts;

  // Version: two lowercase-hex chars; `ff` is reserved. Only version `00`
  // forbids trailing fields.
  if (version.length !== 2 || !HEX.test(version) || version === 'ff') return null;
  if (version === '00' && parts.length !== 4) return null;

  // Fixed widths, lowercase hex, a well-formed 2-char flags field.
  if (traceId.length !== 32 || spanId.length !== 16 || flags.length !== 2) return null;
  if (!HEX.test(traceId) || !HEX.test(spanId) || !HEX.test(flags)) return null;

  // An all-zero trace or span id is invalid per the spec.
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null;

  return { traceId, parentSpanId: spanId };
}

const NANOS_PER_MILLI = 1_000_000n;

/**
 * Milliseconds since the epoch as nanoseconds.
 *
 * The whole and fractional parts are converted separately: epoch nanoseconds
 * are ~1.7e18, far past what a JS number holds exactly, so the multiply has to
 * happen in BigInt.
 */
export function msToUnixNano(ms: number): bigint {
  const whole = Math.trunc(ms);
  const fractionalNanos = Math.round((ms - whole) * 1e6);
  return BigInt(whole) * NANOS_PER_MILLI + BigInt(fractionalNanos);
}
