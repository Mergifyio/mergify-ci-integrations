import { resolve } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVitest } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

describe('Quarantine runner', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('quarantined failing test does not fail the run', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({
      exporter,
      // Quarantine the intentionally failing test
      quarantineList: ['failing.test.ts > math > fails intentionally'],
    });

    const vitest = await startVitest('test', [], {
      root: fixturesDir,
      include: ['failing.test.ts'],
      reporters: [reporter],
      watch: false,
    });
    await vitest?.close();

    const session = reporter.getSession();
    expect(session).toBeDefined();
    // The session should report as passed because the failure was quarantined
    expect(session!.status).toBe('passed');
  });

  it('sets cicd.test.quarantined span attribute on quarantined tests', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({
      exporter,
      quarantineList: ['failing.test.ts > math > fails intentionally'],
    });

    const vitest = await startVitest('test', [], {
      root: fixturesDir,
      include: ['failing.test.ts'],
      reporters: [reporter],
      watch: false,
    });
    await vitest?.close();

    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case');

    expect(testSpan).toBeDefined();
    expect(testSpan!.attributes['cicd.test.quarantined']).toBe(true);
  });

  it('non-quarantined failing test still fails the run', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({
      exporter,
      quarantineList: ['some > other test'],
    });

    const vitest = await startVitest('test', [], {
      root: fixturesDir,
      include: ['failing.test.ts'],
      reporters: [reporter],
      watch: false,
    });
    await vitest?.close();

    const session = reporter.getSession();
    expect(session!.status).toBe('failed');
  });

  it('mixed: quarantined failure + passing test = passing run', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({
      exporter,
      quarantineList: ['mixed.test.ts > outer > inner > fails'],
    });

    const vitest = await startVitest('test', [], {
      root: fixturesDir,
      include: ['mixed.test.ts'],
      reporters: [reporter],
      watch: false,
    });
    await vitest?.close();

    const session = reporter.getSession();
    // The only failure is quarantined, so the run should pass
    expect(session!.status).toBe('passed');

    const spans = exporter.getFinishedSpans();
    const quarantinedSpan = spans.find((s) => s.attributes['cicd.test.quarantined'] === true);
    expect(quarantinedSpan).toBeDefined();
  });
});
