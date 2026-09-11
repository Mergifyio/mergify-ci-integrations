import type { CiApiClient } from '@mergifyio/ci-native';
import type { SpanAttributes } from './types.js';
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
  if (selection === 'full') return fullRun(reason);
  // Named for what happened rather than carrying the server's reason for an
  // answer this client did not honour, so the end-of-run block can say the
  // right thing: an answer this client predates (`empty`, `refused`, or a
  // newer shape) is the normal way the engine grows, and is the user's to fix
  // by upgrading; a subset naming no test cannot come from a correct engine.
  // The same vocabulary as pytest-mergify's `NotAppliedReason`.
  if (selection !== 'subset') return fullRun('unrecognised_selection');
  if (!tests?.length) return fullRun('subset_served_without_tests');
  return { selection: 'subset', reason, tests: new Set(tests) };
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
    // The error text on its own line and never wrapped: it usually carries the
    // request URL, and what support gets pasted must not be a split link. The
    // end-of-run block says what the failure meant for the run.
    logger(
      `Mergify couldn't be asked whether this run could be reduced, so the full suite will run.\nError: ${describeError(err)}`
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

/**
 * One sentence per reason the full suite was served, for the end-of-run
 * block. Written for the developer reading their job log, who wants to know
 * what reduced (or did not reduce) their run and whether it was deliberate --
 * so each names the fact and its consequence, and none of them is the
 * identifier. Twelve engine reasons collapse into nine sentences: two reasons
 * that leave the reader the same thing to do share one, and only the rows
 * that leave them something to do carry a second sentence. The same table as
 * pytest-mergify's, so the three clients say the same thing. Wording
 * validated by Alexandre on 2026-09-11 (MRGFY-8978); a change here is a
 * product decision.
 *
 * `{client}` is the package name (`@mergifyio/vitest`, `@mergifyio/playwright`).
 */
const FULL_RUN_SENTENCES: Readonly<Record<string, string>> = {
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
  // Unlike pytest-mergify's row, no "upgrade it": no version of these clients
  // reports its collection yet (see the binding's `fetch_test_selection`), so
  // an upgrade would not change the answer, and a sentence promising one would
  // send the reader to bump a dependency for nothing.
  no_collection_fingerprint:
    "{client} doesn't report what it collected yet, so the full suite ran.",
  feature_disabled:
    "Test selection isn't enabled for this organization yet, so the full suite ran.",
  // This client's own reasons, never the engine's.
  not_requested: "Test selection isn't available for this repository, so the full suite ran.",
  fetch_failed:
    "Mergify couldn't be asked whether this run could be reduced, so the full suite ran.",
  unrecognised_selection:
    "Mergify answered in a way this version of {client} doesn't understand, so the full suite ran. Upgrade it to let Mergify reduce reruns.",
  // No "please report it": these shapes are a defect on our side that we
  // already see in our own data, and asking the customer to tell us hands
  // them our work. Alexandre, 2026-09-11.
  subset_served_without_tests:
    "Mergify's answer didn't match the tests this run collected, so the full suite ran.",
  subset_matched_no_collected_test:
    "Mergify's answer didn't match the tests this run collected, so the full suite ran.",
};

/**
 * A newer engine may serve a reason this client predates. The block must then
 * still read as a full run, and must never show the raw identifier.
 */
const UNKNOWN_REASON_SENTENCE = 'Mergify served the full suite.';

/**
 * The block's title, the same `<emoji> <Mechanism>` shape as its neighbours in
 * the end-of-run output (🛡️ Quarantine, 🐛 Flaky detection).
 */
const HEADER = '✂️ Test selection';

/**
 * How many re-executed tests the subset block lists by name before it counts
 * the rest: enough to recognise the failures, not enough to bury the sentence
 * above them under a screen of test names.
 */
const LISTED_TESTS_MAX = 10;

/**
 * The paragraphs wrap at this width, which is what the wording was validated
 * at: a block that fits an 80-column log viewer without the viewer's own,
 * uglier wrapping.
 */
const WRAP_WIDTH = 80;

/** Greedy word wrap, breaking only at spaces -- never inside a word or at a hyphen. */
function wrap(text: string, width = WRAP_WIDTH): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.join('\n');
}

function block(text: string): string {
  return `${HEADER}\n\n${wrap(text)}\n`;
}

/**
 * What the reduction came to, as the end-of-run block describes it.
 *
 * Deliberately not `TestSelectionApplication`: Playwright applies a selection
 * to a collection it holds in full, but Vitest only learns what ran from the
 * results, and a served test the user's own filter excluded is matched there
 * without being executed. The block describes what happened, so it takes the
 * executed names, not the matched ones; `outcomeOfApplication` builds this
 * for a reporter that holds the application.
 */
export interface TestSelectionOutcome {
  selection: 'full' | 'subset';
  reason: string;
  /** The tests Mergify re-executed, in collection order. Empty on a full run. */
  reExecuted: readonly string[];
  /**
   * How many entries those names amount to. Differs from `reExecuted.length`
   * only when one identity is several collected entries (a Playwright test in
   * several projects).
   */
  reExecutedCount: number;
  /** How many tests the selection removed. */
  skipped: number;
}

/** The outcome as a reporter that applied the selection to its whole collection sees it. */
export function outcomeOfApplication(application: TestSelectionApplication): TestSelectionOutcome {
  return {
    selection: application.selection,
    reason: application.reason,
    reExecuted: [...application.keep],
    reExecutedCount: application.keptCount,
    skipped: application.deselectedCount,
  };
}

/**
 * The end-of-run block, the same prose as pytest-mergify's `report()`.
 *
 * Written for a developer who opened the job log because it reported 1 test
 * where the suite has thousands, and who wants to know: what reduced my run,
 * was it deliberate, and can I trust this green. So it is prose, not a bullet
 * list, and no identifier from the API ever reaches it -- `reason` is
 * translated, never shown. The block never begins with a package prefix: the
 * caller adds its own on the title line, as it does for its other blocks.
 */
export function formatTestSelectionReport(outcome: TestSelectionOutcome, client: string): string {
  if (outcome.selection !== 'subset') {
    const sentence = FULL_RUN_SENTENCES[outcome.reason] ?? UNKNOWN_REASON_SENTENCE;
    return block(sentence.replaceAll('{client}', client));
  }

  const failed = outcome.reExecutedCount;
  const skipped = outcome.skipped;
  let sentence: string;
  if (skipped === 0) {
    // Every collected test had failed: nothing was skipped, and a sentence
    // about skipping "the 0 that had already passed" would be about nothing.
    const [which, them] =
      failed === 1
        ? ['its only test failed', 'it']
        : [`all ${failed} of its tests failed`, 'all of them'];
    sentence = `The code under test hasn't changed since the previous attempt of this job, where ${which}. Mergify re-executed ${them}:`;
  } else {
    const total = failed + skipped;
    const those = failed === 1 ? 'that one' : `those ${failed}`;
    sentence = `The code under test hasn't changed since the previous attempt of this job, where ${failed} of its ${total} tests failed. Mergify re-executed only ${those} and skipped the ${skipped} that had already passed:`;
  }

  const lines = outcome.reExecuted.slice(0, LISTED_TESTS_MAX).map((name) => `  ${name}`);
  const remaining = outcome.reExecuted.length - LISTED_TESTS_MAX;
  if (remaining > 0) lines.push(`  … and ${remaining} more`);
  return `${block(sentence)}\n${lines.join('\n')}\n`;
}
