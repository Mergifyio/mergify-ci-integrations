import type { TestCase } from '@playwright/test/reporter';

/**
 * Normalize a path to POSIX separators. Quarantine keys and span names must be
 * stable across platforms — the backend stores them as strings and compares
 * byte-for-byte — so every filepath flowing into `extractNamespace`,
 * `stripFileSuite`, or `buildQuarantineKey` MUST pass through this first.
 *
 * No-op on POSIX (input already has no backslashes); maps `\` → `/` on Windows.
 */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Build the namespace for a Playwright test as `<filepath> > <describes>`.
 * `titlePath()` is `[projectName, filePath, ...describes, testTitle]`; we take
 * the describe segments and prepend the caller-normalized filepath so the
 * resulting span name is filepath-qualified, matching the vitest convention
 * (avoiding collisions when two files share a describe+test name).
 */
export function extractNamespace(filepath: string, titlePath: readonly string[]): string {
  const describes = stripFileSuite(titlePath.slice(2, -1), filepath);
  const parts = [filepath, ...describes].filter((p) => p.length > 0);
  return parts.join(' > ');
}

/**
 * At runtime, Playwright exposes the test's file as a suite in `titlePath`
 * (e.g. `[project, file, 'sample.spec.ts', ...describes, title]`), so
 * `titlePath.slice(2, -1)` picks up the filepath again and we'd end up
 * emitting `tests/sample.spec.ts > sample.spec.ts > ...`. Drop any describe
 * entry whose value equals the filepath or its basename.
 *
 * `filepath` must already be POSIX-normalized by the caller (see `toPosix`).
 * The basename split below is deliberately POSIX-only.
 */
export function stripFileSuite(describes: readonly string[], filepath: string): readonly string[] {
  if (filepath.length === 0) return describes;
  const basename = filepath.split('/').pop() ?? '';
  return describes.filter((d) => d !== filepath && d !== basename);
}

/**
 * Build the quarantine-matching key for a Playwright test: the same string the
 * Mergify backend stores as `test_name` (derived from the emitted span name).
 *
 * Must match the span name produced by `emitTestCaseSpan` in @mergifyio/ci-core:
 *   namespace > function  (when namespace is non-empty)
 *   function              (when namespace is empty)
 * where `namespace` is `extractNamespace(filepath, titlePath)`. The filter step
 * below drops the empty prefix in the second case so the equality holds in both.
 */
export function buildQuarantineKey(
  filepath: string,
  titlePath: readonly string[],
  title: string
): string {
  const describes = stripFileSuite(titlePath.slice(2, -1), filepath);
  const parts = [filepath, ...describes, title].filter((p) => p.length > 0);
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
