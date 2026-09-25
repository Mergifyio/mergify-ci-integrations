import { resolve } from 'node:path';
import { type FlakyDetectionContext, InMemorySpanSink } from '@mergifyio/ci-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVitest } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

const flakyContext: FlakyDetectionContext = {
  budget_ratio_for_new_tests: 1.0,
  budget_ratio_for_unhealthy_tests: 1.0,
  existing_test_names: [],
  existing_tests_mean_duration_ms: 100,
  unhealthy_test_names: [],
  budget_ratio_for_test_retries: 0,
  flaky_test_names: [],
  broken_test_names: [],
  max_test_execution_count: 5,
  max_test_name_length: 255,
  min_budget_duration_ms: 10_000,
  min_test_execution_count: 2,
};

describe('Flaky detection runner', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reruns candidate test and detects flakiness', async () => {
    const sink = new InMemorySpanSink();
    const reporter = new MergifyReporter({
      sink,
      flakyContext,
      flakyMode: 'new',
    });

    const vitest = await startVitest('test', [], {
      root: fixturesDir,
      include: ['flaky.test.ts'],
      reporters: [reporter],
      watch: false,
    });
    await vitest?.close();

    const session = reporter.getSession();
    expect(session).toBeDefined();

    // Check spans for flaky detection attributes
    const spans = sink.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case');

    expect(testSpan).toBeDefined();
    expect(testSpan!.attributes['cicd.test.flaky_detection']).toBe(true);
    expect(testSpan!.attributes['cicd.test.new']).toBe(true);
    expect(testSpan!.attributes['cicd.test.rerun_count']).toBeGreaterThan(0);
    // The fixture fails its first run and passes the next: the typical flaky
    // test. Vitest keeps a test's state at `fail` across repeats once a try
    // failed, and skips `onAfterTryTask` on a try that throws, so reading
    // either recorded every repeat as a failure and this was never flagged.
    expect(testSpan!.attributes['cicd.test.flaky']).toBe(true);
  });

  // Unhealthy mode reruns a test already known to be unhealthy only to learn
  // from it: its own first attempt decides the verdict, as in pytest-mergify
  // and rspec-mergify. Absorbing every failure instead turned a test that
  // failed on each attempt green.
  async function runUnhealthy(file: string, testName: string) {
    const sink = new InMemorySpanSink();
    const reporter = new MergifyReporter({
      sink,
      flakyContext: {
        ...flakyContext,
        existing_test_names: [testName],
        unhealthy_test_names: [testName],
      },
      flakyMode: 'unhealthy',
    });
    const vitest = await startVitest('test', [], {
      root: fixturesDir,
      include: [file],
      reporters: [reporter],
      watch: false,
    });
    await vitest?.close();
    const testSpan = sink.getFinishedSpans().find((s) => s.attributes['test.scope'] === 'case');
    return { testSpan: testSpan!, status: reporter.getSession()!.status };
  }

  it('keeps an unhealthy test failing when its first attempt fails', async () => {
    const { testSpan, status } = await runUnhealthy(
      'flaky.test.ts',
      'flaky suite > intermittent test'
    );

    expect(testSpan.attributes['cicd.test.flaky_detection']).toBe(true);
    expect(testSpan.attributes['cicd.test.rerun_count']).toBeGreaterThan(0);
    expect(testSpan.attributes['test.case.result.status']).toBe('failed');
    expect(status).toBe('failed');
  });

  it('absorbs a failure only a rerun of an unhealthy test saw', async () => {
    const { testSpan, status } = await runUnhealthy(
      'unhealthy-late.test.ts',
      'late suite > fails after its first attempt'
    );

    expect(testSpan.attributes['cicd.test.rerun_count']).toBeGreaterThan(0);
    expect(testSpan.attributes['cicd.test.flaky']).toBe(true);
    expect(testSpan.attributes['test.case.result.status']).toBe('passed');
    expect(status).toBe('passed');
  });

  it('does not rerun tests that are not candidates', async () => {
    const sink = new InMemorySpanSink();
    // All tests are "existing" so none are candidates in "new" mode. The names
    // are the ones the reporter uploads — the server has never seen any other
    // shape, so a name carrying the file path would not match here either.
    const ctx = {
      ...flakyContext,
      existing_test_names: ['math > adds numbers'],
    };
    const reporter = new MergifyReporter({
      sink,
      flakyContext: ctx,
      flakyMode: 'new',
    });

    const vitest = await startVitest('test', [], {
      root: fixturesDir,
      include: ['passing.test.ts'],
      reporters: [reporter],
      watch: false,
    });
    await vitest?.close();

    const spans = sink.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case');

    expect(testSpan).toBeDefined();
    // No flaky detection attributes since test is existing
    expect(testSpan!.attributes['cicd.test.flaky_detection']).toBeUndefined();
  });
});
