import { resolve } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVitest } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

function createReporterWithExporter(): {
  reporter: MergifyReporter;
  exporter: InMemorySpanExporter;
} {
  const exporter = new InMemorySpanExporter();
  const reporter = new MergifyReporter({ exporter });
  return { reporter, exporter };
}

async function runFixture(fixture: string, reporter: MergifyReporter): Promise<void> {
  const vitest = await startVitest('test', [], {
    root: fixturesDir,
    include: [fixture],
    reporters: [reporter],
    watch: false,
  });
  await vitest?.close();
}

describe('OTel integration', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates session and test case spans for passing test', async () => {
    const { reporter, exporter } = createReporterWithExporter();
    await runFixture('passing.test.ts', reporter);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);

    const sessionSpan = spans.find((s) => s.attributes['test.scope'] === 'session');
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case');

    expect(sessionSpan).toBeDefined();
    expect(sessionSpan!.name).toBe('vitest session start');

    expect(testSpan).toBeDefined();
    expect(testSpan!.name).toContain('adds numbers');
    expect(testSpan!.attributes['code.function']).toBe('adds numbers');
    expect(testSpan!.attributes['test.case.result.status']).toBe('passed');
    expect(testSpan!.attributes['code.filepath']).toContain('passing.test.ts');

    // Test span should be child of session span
    expect(testSpan!.parentSpanId).toBe(sessionSpan!.spanContext().spanId);
  });

  it('sets exception attributes on failed test span', async () => {
    const { reporter, exporter } = createReporterWithExporter();
    await runFixture('failing.test.ts', reporter);

    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case');

    expect(testSpan).toBeDefined();
    expect(testSpan!.attributes['test.case.result.status']).toBe('failed');
    expect(testSpan!.attributes['exception.type']).toBeTruthy();
    expect(testSpan!.attributes['exception.message']).toBeTruthy();
    expect(testSpan!.attributes['exception.stacktrace']).toBeTruthy();
  });

  it('sets skipped status on skipped test span', async () => {
    const { reporter, exporter } = createReporterWithExporter();
    await runFixture('skipped.test.ts', reporter);

    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case');

    expect(testSpan).toBeDefined();
    expect(testSpan!.attributes['test.case.result.status']).toBe('skipped');
  });

  it('includes resource attributes', async () => {
    const { reporter, exporter } = createReporterWithExporter();
    await runFixture('passing.test.ts', reporter);

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    const span = spans[0];
    const resource = span.resource;

    expect(resource.attributes['test.framework']).toBe('vitest');
    expect(resource.attributes['test.framework.version']).toBeTruthy();
    expect(resource.attributes['test.run.id']).toMatch(/^[0-9a-f]{16}$/);
    expect(resource.attributes['cicd.provider.name']).toBe('github_actions');
    expect(resource.attributes['vcs.repository.name']).toBe('test-owner/test-repo');
  });

  it('creates correct spans for mixed results', async () => {
    const { reporter, exporter } = createReporterWithExporter();
    await runFixture('mixed.test.ts', reporter);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);

    const testSpans = spans.filter((s) => s.attributes['test.scope'] === 'case');
    expect(testSpans).toHaveLength(3);

    const statuses = testSpans.map((s) => s.attributes['test.case.result.status']).sort();
    expect(statuses).toEqual(['failed', 'passed', 'skipped']);
  });
});
