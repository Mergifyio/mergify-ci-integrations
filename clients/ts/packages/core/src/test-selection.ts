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
export function isTestSelectionDisabled(): boolean {
  // A kill switch must never break a run: a value we cannot parse reads as an
  // attempt to disable, exactly as pytest-mergify treats it.
  return envToBool(process.env.MERGIFY_TEST_SELECTION_DISABLE, true);
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
