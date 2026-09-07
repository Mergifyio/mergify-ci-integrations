import type { Span } from '@mergifyio/ci-native';
import { SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';
import type { MergifyApiClient } from '../src/api.js';
import { NativeTraceExporter } from '../src/native-exporter.js';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const PARENT_SPAN_ID = '00f067aa0ba902b7';

function readableSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: 'suite > test',
    spanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 }),
    // 1.5s into the epoch, plus 250ms — chosen so the nanosecond arithmetic is
    // visible in the assertion rather than rounded away.
    startTime: [1, 500_000_000],
    endTime: [1, 750_000_000],
    status: { code: SpanStatusCode.OK },
    attributes: {},
    resource: resourceFromAttributes({}),
    ...overrides,
  } as ReadableSpan;
}

function exporterOver(uploadTrace: MergifyApiClient['uploadTrace']) {
  const client: MergifyApiClient = {
    fetchQuarantine: vi.fn(),
    fetchFlakyContext: vi.fn(),
    fetchTestSelection: vi.fn(),
    uploadTrace,
  };
  return new NativeTraceExporter(client);
}

/** Run one export and resolve with its result. */
function exportSpans(
  exporter: NativeTraceExporter,
  spans: ReadableSpan[]
): Promise<{ code: ExportResultCode; error?: Error }> {
  return new Promise((resolve) => {
    exporter.export(spans, resolve);
  });
}

describe('NativeTraceExporter', () => {
  it('marshals a span into the shape the binding takes', async () => {
    const uploadTrace = vi.fn().mockResolvedValue(undefined);
    const span = readableSpan({
      parentSpanContext: { traceId: TRACE_ID, spanId: PARENT_SPAN_ID, traceFlags: 1 },
      attributes: { 'code.lineno': 12, 'test.scope': 'case', 'cicd.test.flaky': true },
      resource: resourceFromAttributes({ 'test.run.id': 'abc123' }),
    });

    const result = await exportSpans(exporterOver(uploadTrace), [span]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    const [resource, spans] = uploadTrace.mock.calls[0] as [unknown, Span[]];
    expect(resource).toEqual([{ key: 'test.run.id', value: 'abc123' }]);
    expect(spans[0]).toEqual({
      name: 'suite > test',
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      parentSpanId: PARENT_SPAN_ID,
      startUnixNano: 1_500_000_000n,
      endUnixNano: 1_750_000_000n,
      attributes: [
        { key: 'code.lineno', value: 12 },
        { key: 'test.scope', value: 'case' },
        { key: 'cicd.test.flaky', value: true },
      ],
      status: 'ok',
      statusMessage: undefined,
    });
  });

  it('leaves a root span without a parent id', async () => {
    const uploadTrace = vi.fn().mockResolvedValue(undefined);

    await exportSpans(exporterOver(uploadTrace), [readableSpan()]);

    const [, spans] = uploadTrace.mock.calls[0] as [unknown, Span[]];
    expect(spans[0].parentSpanId).toBeUndefined();
  });

  it('carries an error status and its message', async () => {
    const uploadTrace = vi.fn().mockResolvedValue(undefined);
    const span = readableSpan({ status: { code: SpanStatusCode.ERROR, message: 'boom' } });

    await exportSpans(exporterOver(uploadTrace), [span]);

    const [, spans] = uploadTrace.mock.calls[0] as [unknown, Span[]];
    expect(spans[0].status).toBe('error');
    expect(spans[0].statusMessage).toBe('boom');
  });

  it('maps an unset status', async () => {
    const uploadTrace = vi.fn().mockResolvedValue(undefined);
    const span = readableSpan({ status: { code: SpanStatusCode.UNSET } });

    await exportSpans(exporterOver(uploadTrace), [span]);

    const [, spans] = uploadTrace.mock.calls[0] as [unknown, Span[]];
    expect(spans[0].status).toBe('unset');
  });

  it('drops array attributes, which the upload path cannot represent', async () => {
    const uploadTrace = vi.fn().mockResolvedValue(undefined);
    const span = readableSpan({ attributes: { keep: 'yes', drop: ['a', 'b'] } });

    await exportSpans(exporterOver(uploadTrace), [span]);

    const [, spans] = uploadTrace.mock.calls[0] as [unknown, Span[]];
    expect(spans[0].attributes).toEqual([{ key: 'keep', value: 'yes' }]);
  });

  it('never touches the client for an empty batch', async () => {
    const uploadTrace = vi.fn();

    const result = await exportSpans(exporterOver(uploadTrace), []);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(uploadTrace).not.toHaveBeenCalled();
  });

  it('reports a failed upload through the export result', async () => {
    const uploadTrace = vi.fn().mockRejectedValue(new Error('HTTP 500: nope'));

    const result = await exportSpans(exporterOver(uploadTrace), [readableSpan()]);

    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error?.message).toBe('HTTP 500: nope');
  });
});
