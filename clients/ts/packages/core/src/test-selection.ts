import type { CiApiClient } from '@mergifyio/ci-native';
import type { Attributes } from '@opentelemetry/api';
import { describeError, envToBool } from './utils.js';

/**
 * The one backend call test selection needs. Narrower than `MergifyApiClient`
 * on purpose: a caller that never asks for a selection should not have to
 * provide this method, and a test stub for it needs one function, not four.
 */
export type TestSelectionClient = Pick<CiApiClient, 'fetchTestSelection'>;

/**
 * Whether this run should execute only a subset of tests.
 *
 * A merge-queue rerun (a `max_checks_retries` attempt or a bisection step) only
 * needs to replay the tests that failed on the previous attempt. Mergify
 * resolves that server-side from the run's own identity (queue branch + head
 * SHA + job); the bundled binding fetches the answer and it is normalised here.
 *
 * Every error, timeout, or unknown situation degrades to running the full suite
 * — this feature can only remove work, never correctness.
 */
export interface TestSelection {
  selection: 'full' | 'subset';
  /** Why this selection — surfaced in the end-of-run report, never branched on. */
  reason: string;
  /** The identifiers to run. Always empty when `selection` is `full`. */
  tests: ReadonlySet<string>;
}

/**
 * The run's own identity, as this client reports it with every uploaded test —
 * which is how the server matches its records.
 */
export interface TestSelectionCoordinates {
  branch: string;
  headSha: string;
  pipelineName: string;
  jobName: string;
}

function fullRun(reason: string): TestSelection {
  return { selection: 'full', reason, tests: new Set() };
}

/**
 * Normalise a raw answer into a selection, from wherever it came.
 *
 * A subset is only honoured with a non-empty list. Everything else means "run
 * the full suite": a `full` answer, and a `subset` whose list is empty — which
 * says "nothing to replay", never "run nothing". That distinction is load
 * bearing: an empty subset taken literally would deselect every test and, with
 * the caller's stale-subset guard, turn a green branch red. Every path that
 * builds a `TestSelection` goes through here so none can skip it.
 */
export function toTestSelection(
  selection: string,
  reason: string,
  tests: readonly string[] | null | undefined
): TestSelection {
  if (selection !== 'subset' || !tests?.length) return fullRun(reason);
  return { selection: 'subset', reason, tests: new Set(tests) };
}

/**
 * Read the run's identity from the detected resource attributes, or null when
 * any part is missing — outside a CI whose provider reports all four, there is
 * nothing to ask the server about.
 */
export function resolveSelectionCoordinates(
  attributes: Attributes
): TestSelectionCoordinates | null {
  const text = (key: string): string | undefined => {
    const value = attributes[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const branch = text('vcs.ref.head.name');
  const headSha = text('vcs.ref.head.revision');
  const pipelineName = text('cicd.pipeline.name');
  // `mergify.test.job.name` is the operator-set override; the provider's own
  // task name is the fallback. Same precedence as pytest-mergify.
  const jobName = text('mergify.test.job.name') ?? text('cicd.pipeline.task.name');

  if (!branch || !headSha || !pipelineName || !jobName) return null;
  return { branch, headSha, pipelineName, jobName };
}

/** The kill switch, honoured before any network call is made. */
export function isTestSelectionDisabled(
  value = process.env.MERGIFY_TEST_SELECTION_DISABLE
): boolean {
  // An EMPTY value is "unset", not "disable". The standard GitHub Actions idiom
  // for a conditional variable (`${{ cond && 'true' || '' }}`, or a `vars.X`
  // that resolves to nothing) produces `''` for what the author means as
  // absent; reading it as "disable" turns the feature off for a whole workflow
  // with no diagnostic at all. A deliberate divergence from pytest-mergify,
  // which still has that gap.
  if (value === undefined || value.length === 0) return false;
  // Past that, a kill switch must never break a run: a value we cannot parse
  // reads as an attempt to disable, exactly as pytest-mergify treats it.
  return envToBool(value, true);
}

/**
 * The selection for this run, always resolved — a dormant repository, a failed
 * fetch, a `full` answer, and a `subset` the server sent empty all collapse to
 * "run everything", with the reason kept for the report.
 *
 * Intersecting a subset with the tests the framework actually collected is
 * deliberately NOT done here: only the caller holds the collection.
 */
export async function fetchTestSelection(
  client: TestSelectionClient,
  coordinates: TestSelectionCoordinates,
  logger: (msg: string) => void
): Promise<TestSelection> {
  let fetched: Awaited<ReturnType<TestSelectionClient['fetchTestSelection']>>;
  try {
    fetched = await client.fetchTestSelection(
      coordinates.branch,
      coordinates.headSha,
      coordinates.pipelineName,
      coordinates.jobName
    );
  } catch (err) {
    logger(
      `Error when querying Mergify's API, the full test suite will run. Error: ${describeError(err)}`
    );
    return fullRun('fetch_failed');
  }

  // Dormant: the repository has not opted in, or the endpoint is not there.
  if (fetched === null) return fullRun('not_requested');

  return toTestSelection(fetched.selection, fetched.reason, fetched.tests);
}

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
 * and it only means that globally. That is also why this lives here and not in
 * every reporter — a framework that never sees the whole collection before
 * running (Vitest collects per worker) cannot use it, and has to make the
 * emptiness safe some other way rather than pretend this call applies.
 *
 * An array rather than an `Iterable` on purpose: the body needs two passes, and
 * a lazy one-shot iterable would be silently empty on the second.
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
  const keep = new Set<string>();
  let keptCount = 0;
  for (const name of collected) {
    if (!selection.tests.has(name)) continue;
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
