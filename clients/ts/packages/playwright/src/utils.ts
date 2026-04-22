import type { TestCase } from '@playwright/test/reporter';

/**
 * Build the namespace for a Playwright test as `<filepath> > <describes>`.
 * `titlePath()` is `[projectName, filePath, ...describes, testTitle]`; we take
 * the describe segments and prepend the caller-normalized filepath so the
 * resulting span name is filepath-qualified, matching the vitest convention
 * (avoiding collisions when two files share a describe+test name).
 */
export function extractNamespace(filepath: string, titlePath: readonly string[]): string {
  const describes = titlePath.slice(2, -1);
  const parts = [filepath, ...describes].filter((p) => p.length > 0);
  return parts.join(' > ');
}

/**
 * Map a Playwright TestResult.status to our 3-value status.
 */
export function mapStatus(
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'
): 'passed' | 'failed' | 'skipped' {
  if (status === 'passed') return 'passed';
  if (status === 'skipped') return 'skipped';
  return 'failed';
}

/**
 * Return the project name from a TestCase by reading the first element of its
 * titlePath. Returns undefined when empty (test is outside any project).
 */
export function projectNameFromTest(test: TestCase): string | undefined {
  const first = test.titlePath()[0];
  return first && first.length > 0 ? first : undefined;
}
