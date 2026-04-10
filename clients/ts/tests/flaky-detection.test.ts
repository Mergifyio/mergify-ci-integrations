import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FlakyDetectionContext,
  FlakyDetector,
  fetchFlakyDetectionContext,
} from '../src/flaky-detection.js';

const baseContext: FlakyDetectionContext = {
  budget_ratio_for_new_tests: 0.2,
  budget_ratio_for_unhealthy_tests: 0.1,
  existing_test_names: [
    'test.ts > existing > test A',
    'test.ts > existing > test B',
    'test.ts > existing > test C',
  ],
  existing_tests_mean_duration_ms: 100,
  unhealthy_test_names: ['test.ts > existing > test B'],
  max_test_execution_count: 10,
  max_test_name_length: 255,
  min_budget_duration_ms: 1000,
  min_test_execution_count: 3,
};

describe('FlakyDetector', () => {
  describe('candidate selection', () => {
    it('selects new tests in "new" mode', () => {
      const allTests = [
        'test.ts > existing > test A',
        'test.ts > existing > test B',
        'test.ts > test.ts > new > test D',
      ];
      const detector = new FlakyDetector(baseContext, 'new', allTests);
      expect(detector.isCandidate('test.ts > test.ts > new > test D')).toBe(true);
      expect(detector.isCandidate('test.ts > existing > test A')).toBe(false);
    });

    it('selects unhealthy tests in "unhealthy" mode', () => {
      const allTests = [
        'test.ts > existing > test A',
        'test.ts > existing > test B',
        'test.ts > test.ts > new > test D',
      ];
      const detector = new FlakyDetector(baseContext, 'unhealthy', allTests);
      expect(detector.isCandidate('test.ts > existing > test B')).toBe(true);
      expect(detector.isCandidate('test.ts > existing > test A')).toBe(false);
      expect(detector.isCandidate('test.ts > test.ts > new > test D')).toBe(false);
    });

    it('excludes tests with names exceeding max length', () => {
      const longName = 'a'.repeat(256);
      const allTests = [longName];
      const detector = new FlakyDetector(baseContext, 'new', allTests);
      expect(detector.isCandidate(longName)).toBe(false);
    });
  });

  describe('budget calculation', () => {
    it('calculates budget from ratio and existing tests', () => {
      // 3 existing tests × 100ms mean = 300ms total
      // 0.2 ratio = 60ms → but min is 1000ms
      const allTests = [
        'test.ts > existing > test A',
        'test.ts > existing > test B',
        'test.ts > existing > test C',
        'test.ts > new > test',
      ];
      const detector = new FlakyDetector(baseContext, 'new', allTests);
      // Budget should be min(0.2 * 300, 1000) = max(60, 1000) = 1000
      const summary = detector.getSummary();
      expect(summary.budgetMs).toBe(1000);
    });

    it('uses ratio when it exceeds minimum', () => {
      const ctx = {
        ...baseContext,
        existing_tests_mean_duration_ms: 10000, // 10s mean
        min_budget_duration_ms: 100,
      };
      // 3 existing × 10000ms = 30000ms, ratio 0.2 = 6000ms > 100ms min
      const allTests = [
        'test.ts > existing > test A',
        'test.ts > existing > test B',
        'test.ts > existing > test C',
        'test.ts > new > test',
      ];
      const detector = new FlakyDetector(ctx, 'new', allTests);
      const summary = detector.getSummary();
      expect(summary.budgetMs).toBe(6000);
    });
  });

  describe('max repeats calculation', () => {
    it('calculates repeats based on budget and duration', () => {
      const ctx = { ...baseContext, min_budget_duration_ms: 1000, max_test_execution_count: 10 };
      const allTests = ['test.ts > existing > test A', 'test.ts > new > test'];
      const detector = new FlakyDetector(ctx, 'new', allTests);
      // Budget = 1000ms, 1 candidate → perTestDeadline = 1000ms
      // initialDuration = 100ms → floor(1000/100) - 1 = 9 reruns, capped at 10-1=9
      expect(detector.getMaxRepeats('test.ts > new > test', 100)).toBe(9);
    });

    it('returns 0 for too-slow tests', () => {
      const ctx = { ...baseContext, min_budget_duration_ms: 100, min_test_execution_count: 3 };
      const allTests = ['test.ts > existing > test A', 'test.ts > new > test'];
      const detector = new FlakyDetector(ctx, 'new', allTests);
      // Budget = 100ms, 1 candidate → perTestDeadline = 100ms
      // initialDuration = 50ms, 50 × 3 = 150 > 100 → too slow
      expect(detector.getMaxRepeats('test.ts > new > test', 50)).toBe(0);
    });
  });

  describe('flaky detection', () => {
    it('detects flaky when test has both pass and fail outcomes', () => {
      const allTests = ['test.ts > new > test'];
      const detector = new FlakyDetector(baseContext, 'new', allTests);
      detector.recordOutcome('test.ts > new > test', 'pass');
      detector.recordOutcome('test.ts > new > test', 'fail');
      expect(detector.isFlaky('test.ts > new > test')).toBe(true);
    });

    it('does not detect flaky when test only passes', () => {
      const allTests = ['test.ts > new > test'];
      const detector = new FlakyDetector(baseContext, 'new', allTests);
      detector.recordOutcome('test.ts > new > test', 'pass');
      detector.recordOutcome('test.ts > new > test', 'pass');
      expect(detector.isFlaky('test.ts > new > test')).toBe(false);
    });

    it('tracks rerun count', () => {
      const allTests = ['test.ts > new > test'];
      const detector = new FlakyDetector(baseContext, 'new', allTests);
      detector.recordOutcome('test.ts > new > test', 'pass');
      detector.recordOutcome('test.ts > new > test', 'fail');
      detector.recordOutcome('test.ts > new > test', 'pass');
      expect(detector.getRerunCount('test.ts > new > test')).toBe(3);
    });
  });

  describe('summary', () => {
    it('returns summary with rerun data', () => {
      const allTests = ['test.ts > existing > test A', 'test.ts > new > test'];
      const detector = new FlakyDetector(baseContext, 'new', allTests);
      detector.recordOutcome('test.ts > new > test', 'pass');
      detector.recordOutcome('test.ts > new > test', 'fail');

      const summary = detector.getSummary();
      expect(summary.mode).toBe('new');
      expect(summary.candidateCount).toBe(1);
      expect(summary.rerunTests).toHaveLength(1);
      expect(summary.rerunTests[0].flaky).toBe(true);
    });
  });
});

describe('fetchFlakyDetectionContext', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns context from API', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => baseContext,
    });

    const ctx = await fetchFlakyDetectionContext(
      {
        apiUrl: 'https://api.mergify.com',
        token: 'test-token',
        repoName: 'owner/repo',
      },
      vi.fn()
    );

    expect(ctx).toEqual(baseContext);
  });

  it('returns null on error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const ctx = await fetchFlakyDetectionContext(
      {
        apiUrl: 'https://api.mergify.com',
        token: 'test-token',
        repoName: 'owner/repo',
      },
      vi.fn()
    );

    expect(ctx).toBeNull();
  });
});
