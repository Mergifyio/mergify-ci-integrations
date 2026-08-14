import type { TestSelectionResponse } from '@mergifyio/ci-native';
import type { Attributes } from '@opentelemetry/api';
import type { MergifyApiClient } from './api.js';
import { describeError, envToBool } from './utils.js';

/**
 * Whether this run should execute only a subset of tests.
 *
 * A merge-queue rerun (a `max_checks_retries` attempt or a bisection step) only
 * needs to replay the tests that failed on the previous attempt. Mergify
 * resolves that server-side from the run's own identity (queue branch + head
 * SHA + job); {@link fetchTestSelection} asks for the answer and normalises it
 * here. Every error, timeout, or unknown situation degrades to running the full
 * suite — this feature can only remove work, never correctness.
 */
export interface TestSelection {
  selection: 'full' | 'subset';
  /** Why this selection was chosen — surfaced in the plugin report. */
  reason: string;
  /** The test names to run; always empty when `selection` is `full`. */
  tests: string[];
}

/**
 * The run's own identity, as the server needs it to find the previous attempt:
 * the head branch and head revision (a merge-queue draft branch on reruns) plus
 * the job coordinates — the exact values the plugin reports with each uploaded
 * test, so the server can match its records.
 */
export interface TestSelectionCoordinates {
  branch: string;
  headSha: string;
  pipelineName: string;
  jobName: string;
}

/**
 * The selection coordinates for this run, or null when any of them is missing.
 *
 * Null means "don't ask": a request keyed on a partial identity could only
 * match the wrong run, and the full suite is the right answer without one.
 * Mirrors pytest-mergify's `_load_test_selection`, including the
 * `mergify.test.job.name` override taking precedence over the provider's own
 * task name.
 */
export function resolveTestSelectionCoordinates(
  attrs: Attributes
): TestSelectionCoordinates | null {
  const branch = nonEmptyString(attrs['vcs.ref.head.name']);
  const headSha = nonEmptyString(attrs['vcs.ref.head.revision']);
  const pipelineName = nonEmptyString(attrs['cicd.pipeline.name']);
  const jobName =
    nonEmptyString(attrs['mergify.test.job.name']) ??
    nonEmptyString(attrs['cicd.pipeline.task.name']);
  if (!branch || !headSha || !pipelineName || !jobName) return null;
  return { branch, headSha, pipelineName, jobName };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Whether the user turned reduced reruns off via `MERGIFY_TEST_SELECTION_DISABLE`.
 *
 * A kill switch must never break a test run: a value we cannot parse reads as
 * an attempt to disable, not as a reason to raise. `envToBool` already returns
 * its fallback for unparsable input, so passing `true` there is that rule.
 *
 * An EMPTY value is "unset", not "disable" — the standard GitHub Actions idiom
 * for a conditional variable (`${{ cond && 'true' || '' }}`, or a `vars.X` that
 * resolves to nothing) produces `''` for what the user means as absent. Reading
 * it as "disable" would turn the feature off for a whole workflow with no
 * diagnostic at all. `isInCI` already guards `CI=''` the same way; this is a
 * deliberate divergence from pytest-mergify, which has the same gap.
 */
export function isTestSelectionDisabled(
  value = process.env.MERGIFY_TEST_SELECTION_DISABLE
): boolean {
  if (value === undefined || value.length === 0) return false;
  return envToBool(value, true);
}

/**
 * The selection served for `coordinates`, the full suite, or null when nothing
 * was served at all.
 *
 * Three outcomes, deliberately distinct. Null is the dormant repository (no
 * subscription, or an engine without the endpoint): nothing was served, so
 * nothing is reported — the same `null`-is-dormant convention as
 * `fetchQuarantineList` and `fetchFlakyDetectionContext`. A failure is a real
 * answer of "run everything", logged here and reported at the end of the run,
 * because a user whose reruns silently stopped being reduced needs to know why.
 * A `subset` with no tests is normalised to full, so callers only ever see a
 * `subset` they can act on.
 */
export async function resolveTestSelection(
  client: MergifyApiClient,
  coordinates: TestSelectionCoordinates,
  logger: (msg: string) => void
): Promise<TestSelection | null> {
  let fetched: TestSelectionResponse | null;
  try {
    fetched = await client.fetchTestSelection(
      coordinates.branch,
      coordinates.headSha,
      coordinates.pipelineName,
      coordinates.jobName
    );
  } catch (err) {
    logger(
      `Failed to fetch the test selection, the full test suite will run: ${describeError(err)}`
    );
    return { selection: 'full', reason: 'fetch_failed', tests: [] };
  }

  if (fetched === null) return null;

  // A subset is only honoured with a non-empty list; anything else (a `full`
  // answer, or a `subset` the server sent empty) runs everything.
  const tests = fetched.tests ?? [];
  if (fetched.selection !== 'subset' || tests.length === 0) {
    return { selection: 'full', reason: fetched.reason, tests: [] };
  }
  return { selection: 'subset', reason: fetched.reason, tests };
}

/** What a framework should actually run, once the selection met the collection. */
export interface TestSelectionApplication {
  selection: 'full' | 'subset';
  reason: string;
  /** The names to run. Empty — and meaningless — when `selection` is `full`. */
  keep: Set<string>;
  keptCount: number;
  deselectedCount: number;
}

/**
 * Decide what to actually run, given the whole collection.
 *
 * Matching is by exact name — the identifiers Mergify serves are the ones this
 * plugin previously uploaded. Served names absent from the collection are
 * ignored; if NOTHING matches (e.g. the tests were renamed since the previous
 * attempt), the result is `full` — an empty reduced run would turn green
 * without testing anything. So this can widen back to everything, which is why
 * a caller must read `.selection` before it touches `.keep`.
 *
 * `collected` must be the run's whole collection, not one file's or one
 * worker's share of it: the emptiness check is what makes a stale subset safe,
 * and it only means that globally. An array rather than an `Iterable` on
 * purpose — the body needs two passes, and a lazy one-shot iterable would be
 * silently empty on the second.
 */
export function applyToCollected(
  selection: TestSelection,
  collected: readonly string[]
): TestSelectionApplication {
  if (selection.selection !== 'subset') {
    return {
      selection: 'full',
      reason: selection.reason,
      keep: new Set(),
      keptCount: 0,
      deselectedCount: 0,
    };
  }

  // One pass. `keptCount` counts OCCURRENCES, not distinct names — a Playwright
  // test caught in several projects shares one identity but is several collected
  // entries — so the two counts add up to what actually runs.
  const subset = new Set(selection.tests);
  const keep = new Set<string>();
  let keptCount = 0;
  for (const name of collected) {
    if (!subset.has(name)) continue;
    keep.add(name);
    keptCount += 1;
  }

  if (keep.size === 0) {
    return {
      selection: 'full',
      reason: 'subset_matched_no_collected_test',
      keep: new Set(),
      keptCount: 0,
      deselectedCount: 0,
    };
  }

  return {
    selection: 'subset',
    reason: selection.reason,
    keep,
    keptCount,
    deselectedCount: collected.length - keptCount,
  };
}

/** The end-of-run report block, mirroring pytest-mergify's wording. */
export function formatTestSelectionReport(application: TestSelectionApplication): string {
  const lines = [
    '✂️ Test selection',
    `  selection: ${application.selection} (reason: ${application.reason})`,
  ];
  if (application.selection === 'subset') {
    lines.push(
      `  reduced rerun: executing ${application.keptCount} previously-failing test(s), ${application.deselectedCount} deselected`
    );
  }
  return `${lines.join('\n')}\n`;
}
