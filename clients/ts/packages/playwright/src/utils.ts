import { envToBool } from '@mergifyio/ci-core';
import type { TestCase } from '@playwright/test/reporter';

/**
 * Normalize a path to POSIX separators. Quarantine keys and span names must be
 * stable across platforms — the backend stores them as strings and compares
 * byte-for-byte — so every filepath flowing into `extractNamespace`,
 * `stripFileSuite`, or `buildTestKey` MUST pass through this first.
 *
 * No-op on POSIX (input already has no backslashes); maps `\` → `/` on Windows.
 */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Build the namespace for a Playwright test as `<filepath> > <describes>`.
 * In the reporter API `titlePath()` is `['', projectName, file, ...describes,
 * testTitle]` — index 0 is the empty root suite (see `projectNameFromTest`).
 * `slice(2, -1)` therefore yields `[file, ...describes]`; `stripFileSuite`
 * drops the file entry, leaving the describes, which we prepend with the
 * caller-normalized filepath so the span name is filepath-qualified (matching
 * the vitest convention, avoiding collisions when two files share a
 * describe+test name).
 */
export function extractNamespace(filepath: string, titlePath: readonly string[]): string {
  const describes = stripFileSuite(titlePath.slice(2, -1), filepath);
  const parts = [filepath, ...describes].filter((p) => p.length > 0);
  return parts.join(' > ');
}

/**
 * In the reporter API `titlePath()` is `['', project, file, ...describes,
 * title]`, so the `slice(2, -1)` used by `extractNamespace` / `buildTestKey`
 * starts at the `file` entry — without stripping it we'd emit
 * `tests/sample.spec.ts > sample.spec.ts > ...`. Drop any entry whose value
 * equals the filepath or its basename.
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
 * Build the matching key for a Playwright test: the same string the Mergify
 * backend stores as `test_name` (derived from the emitted span name). Used
 * both for quarantine list matching and for flaky-detection candidate
 * matching.
 *
 * Must match the span name produced by `emitTestCaseSpan` in @mergifyio/ci-core:
 *   namespace > function  (when namespace is non-empty)
 *   function              (when namespace is empty)
 * where `namespace` is `extractNamespace(filepath, titlePath)`. The filter step
 * below drops the empty prefix in the second case so the equality holds in both.
 */
export function buildTestKey(
  filepath: string,
  titlePath: readonly string[],
  title: string,
  prefix = ''
): string {
  const describes = stripFileSuite(titlePath.slice(2, -1), filepath);
  const parts = [filepath, ...describes, title].filter((p) => p.length > 0);
  return prefix + parts.join(' > ');
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
 * Return the Playwright project name for a TestCase via its parent suite's
 * `project()`. We deliberately do NOT use `titlePath()[0]`: in the reporter API
 * that slot is the empty root suite, not the project (the project sits at index
 * 1 — mirroring Playwright's own JUnit reporter, which does `titlePath().slice(3)`
 * to "skip root, project, file"). Returns undefined for the unnamed/default
 * project so callers emit no prefix.
 */
export function projectNameFromTest(test: TestCase): string | undefined {
  const name = test.parent?.project()?.name;
  return name && name.length > 0 ? name : undefined;
}

/**
 * Build the JUnit-style project qualifier prepended to a test's identity:
 * `[<project>] > `. Empty/undefined project ⇒ empty string (no prefix). The
 * trailing ` > ` keeps the project a separate delimiter token, so the prefixed
 * key stays a valid Playwright `--test-list` line.
 */
export function projectNamePrefix(project: string | undefined): string {
  return project ? `[${project}] > ` : '';
}

/**
 * Resolve `PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME`. Default is `false`
 * (opt-in): `envToBool` already returns `false` for an unset var, so the
 * default falls out without a special case. Shared by the reporter and the
 * worker-side quarantine fixture — they MUST agree, or quarantine keys silently
 * mismatch.
 */
export function resolveIncludeProject(): boolean {
  return envToBool(process.env.PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME, false);
}
