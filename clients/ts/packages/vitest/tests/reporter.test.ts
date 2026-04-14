import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startVitest } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function runFixture(fixture: string): Promise<MergifyReporter> {
  const reporter = new MergifyReporter();
  const vitest = await startVitest('test', [], {
    root: fixturesDir,
    include: [fixture],
    reporters: [reporter],
    watch: false,
  });
  await vitest?.close();
  return reporter;
}

describe('MergifyReporter', () => {
  describe('session', () => {
    it('creates a session with a 16-char hex test run ID', async () => {
      const reporter = await runFixture('passing.test.ts');
      const session = reporter.getSession();

      expect(session).toBeDefined();
      expect(session!.testRunId).toMatch(/^[0-9a-f]{16}$/);
      expect(session!.scope).toBe('session');
      expect(session!.startTime).toBeGreaterThan(0);
      expect(session!.endTime).toBeGreaterThan(session!.startTime);
    });

    it('sets session status to passed when all tests pass', async () => {
      const reporter = await runFixture('passing.test.ts');
      expect(reporter.getSession()!.status).toBe('passed');
    });

    it('sets session status to failed when a test fails', async () => {
      const reporter = await runFixture('failing.test.ts');
      expect(reporter.getSession()!.status).toBe('failed');
    });
  });

  describe('passing test', () => {
    it('collects result with correct attributes', async () => {
      const reporter = await runFixture('passing.test.ts');
      const session = reporter.getSession()!;

      expect(session.testCases).toHaveLength(1);
      const tc = session.testCases[0];

      expect(tc.scope).toBe('case');
      expect(tc.status).toBe('passed');
      expect(tc.function).toBe('adds numbers');
      expect(tc.namespace).toBe('math');
      expect(tc.filepath).toContain('passing.test.ts');
      expect(tc.lineno).toBeGreaterThan(0);
      expect(tc.duration).toBeGreaterThanOrEqual(0);
      expect(tc.error).toBeUndefined();
    });
  });

  describe('failing test', () => {
    it('captures error details', async () => {
      const reporter = await runFixture('failing.test.ts');
      const session = reporter.getSession()!;

      expect(session.testCases).toHaveLength(1);
      const tc = session.testCases[0];

      expect(tc.status).toBe('failed');
      expect(tc.error).toBeDefined();
      expect(tc.error!.type).toBe('AssertionError');
      expect(tc.error!.message).toBeTruthy();
      expect(tc.error!.stacktrace).toBeTruthy();
    });
  });

  describe('skipped test', () => {
    it('collects skipped status with no error', async () => {
      const reporter = await runFixture('skipped.test.ts');
      const session = reporter.getSession()!;

      expect(session.testCases).toHaveLength(1);
      const tc = session.testCases[0];

      expect(tc.status).toBe('skipped');
      expect(tc.error).toBeUndefined();
    });
  });

  describe('mixed results', () => {
    it('collects all test cases with correct statuses', async () => {
      const reporter = await runFixture('mixed.test.ts');
      const session = reporter.getSession()!;

      expect(session.testCases).toHaveLength(3);
      expect(session.status).toBe('failed');

      const statuses = session.testCases.map((tc) => tc.status).sort();
      expect(statuses).toEqual(['failed', 'passed', 'skipped']);
    });

    it('captures nested suite namespace', async () => {
      const reporter = await runFixture('mixed.test.ts');
      const session = reporter.getSession()!;

      const passing = session.testCases.find((tc) => tc.function === 'passes');
      expect(passing).toBeDefined();
      expect(passing!.namespace).toBe('outer > inner');
    });
  });
});
