import type { TestCase } from '@playwright/test/reporter';

/**
 * Extract the describe chain from a Playwright `titlePath()`.
 * `titlePath()` is `[projectName, filePath, ...describes, testTitle]`.
 * We return the describe segments joined with ` > `.
 */
export function extractNamespace(titlePath: readonly string[]): string {
  if (titlePath.length <= 3) return '';
  return titlePath.slice(2, -1).join(' > ');
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
