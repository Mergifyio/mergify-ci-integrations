import type { CiApiClient } from '@mergifyio/ci-native';
import type { SpanAttributes } from './types.js';
import { describeError, envToBool, wrapText } from './utils.js';

/**
 * The one backend call test selection needs. Narrower than `MergifyApiClient`
 * on purpose: a caller that never asks for a selection should not have to
 * provide this method, and a test stub for it needs one function, not four.
 */
export type TestSelectionClient = Pick<CiApiClient, 'fetchTestSelection'>;

/**
 * The answers this client understands. The vocabulary the SERVER is meant to
 * use, not a guarantee about what `TestSelection.selection` holds: an answer
 * from a newer engine is kept verbatim rather than rewritten, so at runtime it
 * is any string, and `notAppliedReason === 'unrecognised_selection'` is what
 * says so. Never write an exhaustive switch on it.
 */
export type TestSelectionAnswer = 'full' | 'subset' | 'empty' | 'refused';

/**
 * Why a run did not do what Mergify answered. Closed on purpose, and named
 * after the shape of the answer rather than after what the run did with it:
 * what it did is always the same, run everything.
 *
 * THE COUNTING RULE, the same one pytest-mergify states: `unrecognised_selection`
 * is a normal condition (the engine growing a new answer) and must be excluded,
 * or the count moves on every engine release. The other three are unreachable
 * against a correct engine -- under the collection fingerprint, predecessor
 * and rerun collected the same set, so every served id exists in this run --
 * which is what makes a non-zero count of them a defect report rather than a
 * statistic.
 */
export type NotAppliedReason =
  // `subset` with no test in it. An engine that means "run everything" says
  // `full`; a subset naming nothing is a defect on our side, not an answer.
  | 'subset_served_without_tests'
  // A `selection` value this client predates.
  | 'unrecognised_selection'
  // None of the served ids is in this collection.
  | 'subset_matched_no_collected_test'
  // Some are, some are not. Running the intersection would be a reduced run
  // over an arbitrary part of what was asked for, green on tests nobody chose.
  | 'subset_partly_absent_from_collection';

/**
 * Whether this run should execute only a subset of tests.
 *
 * A merge-queue rerun (a `max_checks_retries` attempt or a bisection step) only
 * needs to replay the tests that failed on the previous attempt. Mergify
 * resolves that server-side from the run's own identity (queue branch + head
 * SHA + job) AND from the fingerprint of what this run collected -- a subset is
 * only safe to serve to a run that collects the same tests the previous attempt
 * did. The bundled binding fetches the answer and it is normalised here.
 *
 * Four answers are understood:
 *
 * - `full` -- run everything.
 * - `subset` -- run only `tests`.
 * - `empty` -- run nothing: the previous attempt of this job already ran these
 *   tests and they passed. The run exits green having executed none of them,
 *   and still uploads its session.
 * - `refused` -- Mergify holds several candidate sessions for this job and will
 *   not guess between them. The run FAILS, showing the server's own explanation
 *   (`message`), or `fallbackRefusalMessage` if it sent none.
 *
 * Every error, timeout, and every answer outside that list degrades to running
 * the full suite: the feature can remove work, never correctness, and a client
 * is routinely older than the server it talks to.
 *
 * When an answer cannot be honoured the run executes everything and says so in
 * `notAppliedReason`, never by rewriting `selection` or `reason`: those two
 * carry Mergify's word, and the only moment their value would prove Mergify
 * said something wrong is the moment rewriting them would erase it.
 */
export interface TestSelection {
  selection: TestSelectionAnswer | (string & {});
  /** The server's own word for why, forwarded verbatim; the client's when it never answered. */
  reason: string;
  /** The identifiers to run. Non-empty only on a `subset` this client can act on. */
  tests: ReadonlySet<string>;
  /**
   * What the server wants shown to the CI user about this answer, when it has
   * something to say -- today only a refusal does. Shown verbatim: the wording
   * is the server's so it can be improved without publishing a client.
   */
  message?: string;
  /**
   * Whether Mergify actually answered. False for a dormant repository and for a
   * request that failed: both run the full suite too, but neither was offered
   * anything, so neither is echoed as an answer -- recording a `full` for them
   * would make a repository outside the pilot, and an API that was down,
   * indistinguishable from a run Mergify looked at and chose not to reduce.
   */
  served: boolean;
  /**
   * The bare error text when the request itself failed -- what support will
   * ask for. The terminal block wraps it in its own sentence about what the
   * failure meant for this run, so it must not already be one.
   */
  fetchError?: string;
  /** Set when the answer's own shape cannot be acted on; see `NotAppliedReason`. */
  notAppliedReason?: NotAppliedReason;
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

function fullRun(reason: string, fetchError?: string): TestSelection {
  return {
    selection: 'full',
    reason,
    tests: new Set(),
    served: false,
    ...(fetchError !== undefined && { fetchError }),
  };
}

/**
 * Normalise a raw answer into a selection, from wherever it came.
 *
 * `empty` and `refused` are answers in themselves and carry no tests, and so
 * does `full`. A subset is only honoured with a non-empty list; a `subset` the
 * server sent empty, and a variant this client predates, both run everything
 * and say so. Every path that builds a served `TestSelection` goes through
 * here so none can skip it.
 */
export function toTestSelection(
  selection: string,
  reason: string,
  tests: readonly string[] | null | undefined,
  message?: string | null
): TestSelection {
  const base = {
    selection,
    reason,
    served: true,
    ...(message ? { message } : {}),
  };
  if (selection === 'subset') {
    if (!tests?.length) {
      return { ...base, tests: new Set(), notAppliedReason: 'subset_served_without_tests' };
    }
    return { ...base, tests: new Set(tests) };
  }
  if (selection === 'full' || selection === 'empty' || selection === 'refused') {
    return { ...base, tests: new Set() };
  }
  return { ...base, tests: new Set(), notAppliedReason: 'unrecognised_selection' };
}

/**
 * Read the run's identity from the detected resource attributes, or null when
 * any part is missing — outside a CI whose provider reports all four, there is
 * nothing to ask the server about.
 */
export function resolveSelectionCoordinates(
  attributes: SpanAttributes
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

/**
 * The environment variable a job sets to ask for test selection.
 *
 * Exported so the reporters name it once — an error message that tells a user
 * to unset a variable spelt differently from the one they set is worse than no
 * message at all.
 */
export const TEST_SELECTION_ENABLE_ENV = 'MERGIFY_TEST_SELECTION_ENABLE';

/**
 * Whether this job asked for test selection.
 *
 * Opt-in, per job, and read before anything else: the feature decides not to
 * run tests, so it starts only where the customer wrote that it should.
 * Installing the plugin buys tracing, quarantine and flaky detection; it does
 * not buy a reduced run.
 *
 * A job that has not opted in makes NO request at all, rather than one the
 * server answers "not opted in". That is deliberate and load bearing on the
 * server's side: a session's stored selection answer is null exactly when its
 * job never asked, which is what lets Mergify tell an instrumented repository
 * that has never opted in from one that has (MRGFY-9172). Asking in order to
 * be refused would set that column everywhere and erase the distinction.
 *
 * Everything unrecognised is off. Unset is off, the empty string is off — the
 * standard GitHub Actions idiom for a conditional variable
 * (`${{ cond && 'true' || '' }}`, or a `vars.X` that resolves to nothing)
 * produces `''` for what the author means as absent — and so is a value we
 * cannot parse: a mistyped `true` must not start skipping tests. All three
 * point the same way, towards running the whole suite.
 *
 * Trimmed, unlike the other variables this package reads, because this one is
 * read by pytest-mergify too and `is_env_true` strips there. One `env:` block
 * at the top of a workflow feeds jobs of both kinds, so a YAML block scalar or
 * a stray trailing space must not opt the Python job in and leave the
 * JavaScript ones out, with nothing said on either side.
 */
export function isTestSelectionEnabled(value = process.env[TEST_SELECTION_ENABLE_ENV]): boolean {
  return envToBool(value?.trim(), false);
}

/**
 * The selection for this run, always resolved — a dormant repository, a failed
 * fetch, a `full` answer, and a `subset` the server sent empty all collapse to
 * "run everything", with the reason kept for the report.
 *
 * `collectionFingerprint` is the identity of what this run collected (the
 * binding's `testCollectionFingerprint`): a subset is only safe to serve to a
 * run that collects the same tests the previous attempt did, so a request
 * without one is answered with the full suite. A caller that holds no
 * collection at the moment it asks (Vitest collects inside its workers) sends
 * none at all rather than claiming an empty one.
 *
 * Intersecting a subset with the tests the framework actually collected is
 * deliberately NOT done here: only the caller holds the collection.
 */
export async function fetchTestSelection(
  client: TestSelectionClient,
  coordinates: TestSelectionCoordinates,
  logger: (msg: string) => void,
  collectionFingerprint?: string
): Promise<TestSelection> {
  let fetched: Awaited<ReturnType<TestSelectionClient['fetchTestSelection']>>;
  try {
    fetched = await client.fetchTestSelection(
      coordinates.branch,
      coordinates.headSha,
      coordinates.pipelineName,
      coordinates.jobName,
      collectionFingerprint
    );
  } catch (err) {
    const error = describeError(err);
    logger(`Error when querying Mergify's API, the full test suite will run. Error: ${error}`);
    return fullRun('fetch_failed', error);
  }

  // Dormant: the repository has not opted in, or the endpoint is not there.
  if (fetched === null) return fullRun('not_requested');

  return toTestSelection(fetched.selection, fetched.reason, fetched.tests, fetched.message);
}

/**
 * What the run does with the answer, once it has met the collection.
 *
 * `outcome` is the run's own verb -- what it executes -- and is the only field
 * a caller branches on; `selection` stays Mergify's answer verbatim, for the
 * report and for the echo the session carries.
 */
export interface TestSelectionApplication {
  selection: TestSelection;
  outcome: TestSelectionAnswer;
  /** Why the answer was not honoured: the answer's own reason, or the collection's. */
  notAppliedReason?: NotAppliedReason;
  /** On a `subset`: the identifiers to run. Empty on every other outcome. */
  keep: ReadonlySet<string>;
  /** The kept identifiers in collection order, for the terminal block. */
  keptTests: readonly string[];
  /**
   * How many tests the selection left this run to run: the whole collection on
   * a full run and on a run that could not apply its answer, the served subset
   * on a reduced one, none on `empty` and none on a refusal.
   */
  keptCount: number;
  deselectedCount: number;
}

/**
 * Decide what to actually run, given the whole collection as distinct
 * identifiers in collection order.
 *
 * Matching is by exact name — the identifiers Mergify serves are the ones this
 * plugin previously uploaded. A subset is honoured all or not at all: one
 * served id this collection does not hold declines the whole answer and runs
 * everything, rather than reducing to the part that did match. Under the
 * collection fingerprint that cannot come from a correct engine, so it is ours
 * to notice; running the intersection would look like an ordinary reduction.
 *
 * `collected` must be the run's whole collection, not one file's or one
 * worker's share of it: the all-or-nothing rule only means something globally.
 * That is also why this lives here and not in every reporter — a framework that
 * never sees the whole collection before running (Vitest collects per worker)
 * cannot use it.
 *
 * An `empty` answer over a collection that is already empty leaves the
 * counters alone: the run is then red for a reason of its own (a filter
 * matching nothing), and recording an application would have this answer both
 * green that exit code and announce a skip over a suite it never emptied.
 */
export function applyToCollected(
  selection: TestSelection,
  collected: readonly string[]
): TestSelectionApplication {
  const full = (notAppliedReason?: NotAppliedReason): TestSelectionApplication => ({
    selection,
    outcome: 'full',
    ...(notAppliedReason && { notAppliedReason }),
    keep: new Set(),
    keptTests: [],
    keptCount: collected.length,
    deselectedCount: 0,
  });

  if (selection.notAppliedReason) return full(selection.notAppliedReason);

  if (selection.selection === 'refused') {
    return {
      selection,
      outcome: 'refused',
      keep: new Set(),
      keptTests: [],
      keptCount: 0,
      deselectedCount: 0,
    };
  }

  if (selection.selection === 'empty') {
    return {
      selection,
      outcome: 'empty',
      keep: new Set(),
      keptTests: [],
      keptCount: 0,
      deselectedCount: collected.length,
    };
  }

  if (selection.selection !== 'subset') return full();

  const keptTests = collected.filter((name) => selection.tests.has(name));
  const keep = new Set(keptTests);
  if (keep.size !== selection.tests.size) {
    return full(
      keep.size === 0 ? 'subset_matched_no_collected_test' : 'subset_partly_absent_from_collection'
    );
  }

  return {
    selection,
    outcome: 'subset',
    keep,
    keptTests,
    keptCount: keptTests.length,
    deselectedCount: collected.length - keptTests.length,
  };
}

/**
 * What the session says about its own reduction, echoed on the trace resource
 * — where the engine reads it from, because nothing on the server keeps its
 * own answer (it is computed, served, and dropped). Undefined when Mergify never answered: recording a `full` for
 * a run nobody looked at would make "we never looked" and "we looked and chose
 * not to reduce" indistinguishable in every count taken afterwards.
 *
 * `answer` is the answer as SENT, never as applied; what the run did with it
 * is `not_applied_reason`, present exactly when the answer was not honoured.
 */
export interface TestSelectionEcho {
  answer: string;
  reason: string;
  kept_count: number;
  not_applied_reason?: NotAppliedReason;
}

export function selectionEcho(
  application: TestSelectionApplication
): TestSelectionEcho | undefined {
  if (!application.selection.served) return undefined;
  return {
    answer: application.selection.selection,
    reason: application.selection.reason,
    kept_count: application.keptCount,
    ...(application.notAppliedReason && { not_applied_reason: application.notAppliedReason }),
  };
}

/** The resource attributes pytest-mergify reports, under the same keys. */
export const TEST_COLLECTION_FINGERPRINT_ATTRIBUTE = 'test.collection.fingerprint';
export const TEST_COLLECTION_COUNT_ATTRIBUTE = 'test.collection.count';
export const TEST_SELECTION_ANSWER_ATTRIBUTE = 'test.selection.answer';
export const TEST_SELECTION_REASON_ATTRIBUTE = 'test.selection.reason';
export const TEST_SELECTION_KEPT_COUNT_ATTRIBUTE = 'test.selection.kept_count';
export const TEST_SELECTION_NOT_APPLIED_REASON_ATTRIBUTE = 'test.selection.not_applied_reason';

/** The identity of what a run collected: the digest and how many tests it holds. */
export interface TestCollection {
  fingerprint: string;
  count: number;
}

/**
 * The resource attributes describing the collection and, when Mergify
 * answered, the echo. The count travels on every run that fingerprinted, with
 * or without an answer: it is the denominator a reduction is read against, and
 * the engine cannot recount it from the uploaded results.
 */
export function selectionResourceAttributes(
  collection: TestCollection,
  echo: TestSelectionEcho | undefined
): SpanAttributes {
  const attributes: SpanAttributes = {
    [TEST_COLLECTION_FINGERPRINT_ATTRIBUTE]: collection.fingerprint,
    [TEST_COLLECTION_COUNT_ATTRIBUTE]: collection.count,
  };
  if (echo) {
    attributes[TEST_SELECTION_ANSWER_ATTRIBUTE] = echo.answer;
    attributes[TEST_SELECTION_REASON_ATTRIBUTE] = echo.reason;
    attributes[TEST_SELECTION_KEPT_COUNT_ATTRIBUTE] = echo.kept_count;
    if (echo.not_applied_reason) {
      attributes[TEST_SELECTION_NOT_APPLIED_REASON_ATTRIBUTE] = echo.not_applied_reason;
    }
  }
  return attributes;
}

/** Which client is talking, for the two sentences that name one. */
export interface TestSelectionClientIdentity {
  /** The package name, as the user installed it: `@mergifyio/playwright`. */
  name: string;
  /** Its documentation page, where `MERGIFY_TEST_JOB_NAME` is described. */
  docsUrl: string;
}

/**
 * What a refusal says when the server sent no wording of its own. The copy
 * belongs to the server -- it can be corrected there without publishing a
 * client, and it alone knows which job it is talking about -- so this is a
 * fallback, not the message. pytest-mergify's, with the client's own
 * documentation page.
 */
export function fallbackRefusalMessage(client: TestSelectionClientIdentity): string {
  return (
    'Mergify Test Selection stopped this run.\n' +
    '\n' +
    'Several runs of this job report to Mergify under the same name, and they' +
    ' run the same tests — so Mergify cannot tell which one this run repeats,' +
    ' and it will not guess which tests to skip.\n' +
    '\n' +
    'If this job runs more than once (a build matrix, for example), give each' +
    ' run its own name with MERGIFY_TEST_JOB_NAME:\n' +
    `${client.docsUrl}\n` +
    '\n' +
    'If this job only runs once, this is unexpected — please contact Mergify' +
    ' support.'
  );
}

const NOT_APPLIED_SENTENCE =
  "Mergify's answer didn't match the tests this run collected, so the full suite ran.";

/**
 * One sentence per reason the full suite was served, for the terminal block.
 * pytest-mergify's `_FULL_RUN_SENTENCES` verbatim (wording validated by
 * Alexandre on 2026-09-11, MRGFY-8978; the two verdict-era reasons on
 * MRGFY-9312), with one substitution: the two sentences that name the client
 * name this one. A change here is a product decision.
 */
function fullRunSentences(client: TestSelectionClientIdentity): Record<string, string> {
  return {
    no_predecessor: 'First attempt of this batch, so the full suite ran.',
    not_a_merge_queue_run: "This job isn't part of a merge queue run, so the full suite ran.",
    stale_run: 'The batch branch was updated while this job was running, so the full suite ran.',
    no_matching_test_session:
      "The previous attempt didn't run this exact set of tests, so the full suite ran.",
    matched_test_session_ran_no_test:
      'The previous attempt executed no tests, so the full suite ran.',
    predecessor_unknown:
      "Mergify couldn't tell which previous run to start from, so the full suite ran.",
    indeterminate_test_session:
      "Mergify couldn't tell which previous run to start from, so the full suite ran.",
    matched_test_session_partially_processed:
      "Mergify didn't have the complete results of the previous attempt, so the full suite ran.",
    matched_test_session_dropped_cases:
      "Mergify didn't have the complete results of the previous attempt, so the full suite ran.",
    matched_test_session_declaration_unreadable:
      "Mergify didn't have the complete results of the previous attempt, so the full suite ran.",
    matched_test_session_incomplete:
      'The previous attempt stopped before running all of its tests, so the full suite ran.',
    matched_test_session_failures_truncated:
      'The previous attempt had too many failures for Mergify to list, so the full suite ran.',
    no_collection_fingerprint:
      `This version of ${client.name} doesn't report what it collected, so the full suite ran.` +
      ' Upgrade it to let Mergify reduce reruns.',
    feature_disabled:
      "Test selection isn't enabled for this organization yet, so the full suite ran.",
    not_requested: "Test selection isn't available for this repository, so the full suite ran.",
    unrecognised_selection:
      `Mergify answered in a way this version of ${client.name} doesn't understand, so the` +
      ' full suite ran. Upgrade it to let Mergify reduce reruns.',
    subset_served_without_tests: NOT_APPLIED_SENTENCE,
    subset_matched_no_collected_test: NOT_APPLIED_SENTENCE,
    subset_partly_absent_from_collection: NOT_APPLIED_SENTENCE,
  };
}

// A newer engine may serve a reason this client predates. The block must then
// still read as a full run, and must never show the raw identifier.
const UNKNOWN_REASON_SENTENCE = 'Mergify served the full suite.';

const HEADER = '✂️ Test selection';

// How many re-executed tests the subset block lists by name before it counts
// the rest. Enough to recognise the failures, not enough to bury the sentence
// above them under a screen of identifiers.
const LISTED_TESTS_MAX = 10;

// The paragraphs wrap at this width, which is what the wording was validated
// at: a block that fits an 80-column log viewer without the viewer's own,
// uglier wrapping.
const WRAP_WIDTH = 80;

function countTests(count: number): string {
  return count === 1 ? '1 test' : `${count} tests`;
}

function block(text: string): string {
  return `${HEADER}\n\n${wrapText(text, WRAP_WIDTH)}\n`;
}

/**
 * The block a reporter prints at the end of the run: pytest-mergify's, so a
 * developer who opened the job log because it reported 1 test where the suite
 * has thousands reads the same prose whatever the framework. No identifier
 * from the API ever reaches it -- `reason` is translated, never shown.
 *
 * Undefined when Mergify was never asked -- a job that never opted in, an
 * incomplete run identity: there is nothing to say about a reduction that was
 * never on the table.
 */
export function formatTestSelectionReport(
  application: TestSelectionApplication,
  client: TestSelectionClientIdentity
): string {
  const { selection } = application;

  if (selection.fetchError !== undefined) {
    // The error text is appended verbatim on its own line rather than wrapped
    // into the sentence: it is what support will ask for, and it usually
    // carries a URL that wrapping would split.
    return `${block(
      "Mergify couldn't be asked whether this run could be reduced, so the full suite ran."
    )}Error: ${selection.fetchError}\n`;
  }

  if (application.outcome === 'refused') {
    // The engine's explanation already reached the developer: the reporter
    // printed it the moment it stopped the run. Repeating five paragraphs here
    // would show it twice, so the block only says where to look.
    return block(
      'Mergify stopped this run before any test ran; its explanation is in the error above.'
    );
  }

  if (application.outcome === 'empty') return emptyBlock(application.deselectedCount);

  if (application.outcome === 'subset') return subsetBlock(application);

  const sentences = fullRunSentences(client);
  return block(
    sentences[application.notAppliedReason ?? selection.reason] ?? UNKNOWN_REASON_SENTENCE
  );
}

function emptyBlock(skipped: number): string {
  if (skipped === 0) {
    // A filter left nothing to run and the runner says so. A paragraph about
    // Mergify skipping "all 0 tests" would send whoever is debugging that red
    // job to look at Mergify instead of at their own filter, so the block is
    // the title alone.
    return `${HEADER}\n`;
  }
  const [passed, them] =
    skipped === 1
      ? ['its only test passed back then', 'it']
      : [`all ${skipped} tests passed back then`, 'them'];
  return block(
    "The code under test hasn't changed since the previous attempt of this job, and" +
      ` ${passed}. Mergify skipped ${them}: the job is green, and no test was executed.`
  );
}

function subsetBlock(application: TestSelectionApplication): string {
  const failed = application.keptCount;
  const skipped = application.deselectedCount;
  let sentence: string;
  if (skipped === 0) {
    // Every collected test had failed: nothing was skipped, and a sentence
    // about skipping "the 0 that had already passed" would be a sentence about
    // nothing.
    const [which, them] =
      failed === 1
        ? ['its only test failed', 'it']
        : [`all ${failed} of its tests failed`, 'all of them'];
    sentence =
      "The code under test hasn't changed since the previous attempt of this job," +
      ` where ${which}. Mergify re-executed ${them}:`;
  } else {
    const those = failed === 1 ? 'that one' : `those ${failed}`;
    sentence =
      "The code under test hasn't changed since the previous attempt of this job," +
      ` where ${failed} of its ${countTests(failed + skipped)} failed. Mergify re-executed only` +
      ` ${those} and skipped the ${skipped} that had already passed:`;
  }

  const lines = application.keptTests.slice(0, LISTED_TESTS_MAX).map((name) => `  ${name}`);
  const remaining = application.keptTests.length - LISTED_TESTS_MAX;
  if (remaining > 0) lines.push(`  … and ${remaining} more`);
  return `${block(sentence)}\n${lines.join('\n')}\n`;
}
