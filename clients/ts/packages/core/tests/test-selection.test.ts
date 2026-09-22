import { describe, expect, it, vi } from 'vitest';
import {
  applyToCollected,
  fallbackRefusalMessage,
  fetchTestSelection,
  formatTestSelectionReport,
  isTestSelectionEnabled,
  resolveSelectionCoordinates,
  selectionEcho,
  selectionResourceAttributes,
  TEST_SELECTION_ENABLE_ENV,
  type TestSelection,
  type TestSelectionClient,
  toTestSelection,
} from '../src/test-selection.js';

// HTTP status handling (402/404 dormant, a `subset` missing its `tests` list
// surfaced as a failure) lives in the Rust client and is tested there. What
// remains here is the rule the whole feature rests on: an answer this client
// cannot act on runs the full suite AND says so, without rewriting the answer.
function client(fetch: TestSelectionClient['fetchTestSelection']): TestSelectionClient {
  return { fetchTestSelection: fetch };
}

const CLIENT = {
  name: '@mergifyio/playwright',
  docsUrl: 'https://docs.mergify.com/ci-insights/test-frameworks/playwright/',
};

const COORDINATES = {
  branch: 'mergify/merge-queue/main',
  headSha: 'cafe1234',
  pipelineName: 'CI',
  jobName: 'unit',
};

describe('fetchTestSelection', () => {
  it('honours a non-empty subset', async () => {
    const selection = await fetchTestSelection(
      client(async () => ({
        selection: 'subset',
        reason: 'reduced_rerun',
        tests: ['suite > a', 'suite > b'],
      })),
      COORDINATES,
      vi.fn()
    );

    expect(selection.selection).toBe('subset');
    expect(selection.reason).toBe('reduced_rerun');
    expect(selection.tests).toEqual(new Set(['suite > a', 'suite > b']));
    expect(selection.served).toBe(true);
    expect(selection.notAppliedReason).toBeUndefined();
  });

  it('passes the run identity and the collection fingerprint through to the client', async () => {
    const fetch = vi.fn().mockResolvedValue(null);

    await fetchTestSelection(client(fetch), COORDINATES, vi.fn(), 'f1');

    expect(fetch).toHaveBeenCalledWith('mergify/merge-queue/main', 'cafe1234', 'CI', 'unit', 'f1');
  });

  it('sends no fingerprint at all when the caller holds none', async () => {
    // Not an empty one: the server tells "a client that has not implemented
    // the fingerprint" apart from "a collection whose fingerprint is empty"
    // by the parameter's absence.
    const fetch = vi.fn().mockResolvedValue(null);

    await fetchTestSelection(client(fetch), COORDINATES, vi.fn());

    expect(fetch).toHaveBeenCalledWith(
      'mergify/merge-queue/main',
      'cafe1234',
      'CI',
      'unit',
      undefined
    );
  });

  it('carries an `empty` answer as such: nothing to run, and nothing not applied', async () => {
    const selection = await fetchTestSelection(
      client(async () => ({ selection: 'empty', reason: 'queue_rerun' })),
      COORDINATES,
      vi.fn()
    );

    expect(selection.selection).toBe('empty');
    expect(selection.tests.size).toBe(0);
    expect(selection.notAppliedReason).toBeUndefined();
  });

  it('carries a refusal with the server message verbatim', async () => {
    const selection = await fetchTestSelection(
      client(async () => ({
        selection: 'refused',
        reason: 'ambiguous_test_sessions',
        message: 'several sessions reported under `unit`',
      })),
      COORDINATES,
      vi.fn()
    );

    expect(selection.selection).toBe('refused');
    expect(selection.message).toBe('several sessions reported under `unit`');
  });

  it('keeps an answer it predates verbatim and declares it unrecognised', async () => {
    // The mechanism by which the engine grows new answers without breaking
    // the clients already published: the value travels as served, and the
    // run says it could not act on it.
    const selection = await fetchTestSelection(
      client(async () => ({ selection: 'bisect', reason: 'new_reason' })),
      COORDINATES,
      vi.fn()
    );

    expect(selection.selection).toBe('bisect');
    expect(selection.reason).toBe('new_reason');
    expect(selection.notAppliedReason).toBe('unrecognised_selection');
    expect(selection.tests.size).toBe(0);
  });

  it('runs everything on a full answer, keeping the server reason', async () => {
    const selection = await fetchTestSelection(
      client(async () => ({ selection: 'full', reason: 'no_predecessor' })),
      COORDINATES,
      vi.fn()
    );

    expect(selection.selection).toBe('full');
    expect(selection.reason).toBe('no_predecessor');
    expect(selection.tests.size).toBe(0);
  });

  it('runs everything when `tests` arrives null rather than absent', async () => {
    // The binding types the field optional, but it crosses a JS boundary and
    // `null` is what an absent Rust `Option` can surface as. Neither spelling
    // may be read as "run nothing".
    const selection = await fetchTestSelection(
      client(async () => ({ selection: 'subset', reason: 'reduced_rerun', tests: null }) as never),
      COORDINATES,
      vi.fn()
    );

    expect(selection.selection).toBe('subset');
    expect(selection.notAppliedReason).toBe('subset_served_without_tests');
    expect(selection.tests.size).toBe(0);
  });

  it('runs everything when a subset arrives empty, and says the answer was not applied', async () => {
    // An empty list is never "run nothing" — reading it that way would turn
    // the suite green without executing anything. An engine that means "run
    // everything" says `full`, so the answer is kept and declared, not
    // rewritten into a `full` Mergify never said.
    const selection = await fetchTestSelection(
      client(async () => ({ selection: 'subset', reason: 'reduced_rerun', tests: [] })),
      COORDINATES,
      vi.fn()
    );

    expect(selection.selection).toBe('subset');
    expect(selection.reason).toBe('reduced_rerun');
    expect(selection.notAppliedReason).toBe('subset_served_without_tests');
    expect(selection.tests.size).toBe(0);
  });

  it('runs everything when the repository is dormant, and was not served', async () => {
    const selection = await fetchTestSelection(
      client(async () => null),
      COORDINATES,
      vi.fn()
    );

    expect(selection.selection).toBe('full');
    expect(selection.reason).toBe('not_requested');
    expect(selection.served).toBe(false);
  });

  it('runs everything and logs when the fetch fails', async () => {
    const logger = vi.fn();

    const selection = await fetchTestSelection(
      client(async () => {
        throw new Error('Mergify API returned HTTP 500');
      }),
      COORDINATES,
      logger
    );

    expect(selection.selection).toBe('full');
    expect(selection.reason).toBe('fetch_failed');
    expect(selection.served).toBe(false);
    expect(selection.fetchError).toBe('Mergify API returned HTTP 500');
    expect(logger).toHaveBeenCalledWith(
      "Error when querying Mergify's API, the full test suite will run. Error: Mergify API returned HTTP 500"
    );
  });
});

describe('resolveSelectionCoordinates', () => {
  const complete = {
    'vcs.ref.head.name': 'mergify/merge-queue/main',
    'vcs.ref.head.revision': 'cafe1234',
    'cicd.pipeline.name': 'CI',
    'cicd.pipeline.task.name': 'unit',
  };

  it('reads the run identity from the resource attributes', () => {
    expect(resolveSelectionCoordinates(complete)).toEqual(COORDINATES);
  });

  it('prefers the operator-set job name over the provider task name', () => {
    expect(
      resolveSelectionCoordinates({ ...complete, 'mergify.test.job.name': 'unit (shard 2)' })
    ).toEqual({ ...COORDINATES, jobName: 'unit (shard 2)' });
  });

  it.each(Object.keys(complete))('returns null without %s', (missing) => {
    const partial = { ...complete, [missing]: undefined };
    expect(resolveSelectionCoordinates(partial)).toBeNull();
  });

  it('treats an empty attribute as missing', () => {
    expect(resolveSelectionCoordinates({ ...complete, 'vcs.ref.head.revision': '' })).toBeNull();
  });
});

describe('isTestSelectionEnabled', () => {
  it('is off until a job asks for it', () => {
    vi.stubEnv('MERGIFY_TEST_SELECTION_ENABLE', undefined);
    expect(isTestSelectionEnabled()).toBe(false);
    vi.unstubAllEnvs();
  });

  it.each(['1', 'true', 'yes', 'on', 'TRUE', ' true '])('is on for %j', (value) => {
    vi.stubEnv('MERGIFY_TEST_SELECTION_ENABLE', value);
    expect(isTestSelectionEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });

  it('reads the variable named by TEST_SELECTION_ENABLE_ENV', () => {
    // The reporters print that constant at users; a message naming a variable
    // this function does not read would send them to fix the wrong line.
    vi.stubEnv(TEST_SELECTION_ENABLE_ENV, 'true');
    expect(isTestSelectionEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });

  it.each(['false', '0', 'no', 'off'])('stays off on %s', (value) => {
    expect(isTestSelectionEnabled(value)).toBe(false);
  });

  it('stays off on whitespace alone', () => {
    // The trim that makes ` true ` a yes must not make a blank value one.
    expect(isTestSelectionEnabled('  ')).toBe(false);
  });

  it('stays off on the empty string', () => {
    // `${{ cond && 'true' || '' }}` and a `vars.X` that resolves to nothing
    // both produce this for what the author means as "not set".
    expect(isTestSelectionEnabled('')).toBe(false);
  });

  it('stays off on an unparsable value rather than start skipping tests', () => {
    expect(isTestSelectionEnabled('maybe')).toBe(false);
  });
});

describe('applyToCollected', () => {
  const served = (tests: string[]): TestSelection =>
    toTestSelection('subset', 'reduced_rerun', tests);

  it('keeps the served tests and deselects the rest', () => {
    const applied = applyToCollected(served(['a', 'c']), ['a', 'b', 'c', 'd']);

    expect(applied.outcome).toBe('subset');
    expect(applied.keep).toEqual(new Set(['a', 'c']));
    expect(applied.keptTests).toEqual(['a', 'c']);
    expect(applied.keptCount).toBe(2);
    expect(applied.deselectedCount).toBe(2);
    expect(applied.notAppliedReason).toBeUndefined();
  });

  it('lists the kept tests in collection order, not in served order', () => {
    const applied = applyToCollected(served(['d', 'a']), ['a', 'b', 'c', 'd']);

    expect(applied.keptTests).toEqual(['a', 'd']);
  });

  it('runs the full suite when the served subset matches nothing', () => {
    const applied = applyToCollected(served(['renamed']), ['a', 'b']);

    expect(applied.outcome).toBe('full');
    expect(applied.notAppliedReason).toBe('subset_matched_no_collected_test');
    expect(applied.keep.size).toBe(0);
    expect(applied.keptCount).toBe(2);
    expect(applied.deselectedCount).toBe(0);
    // Mergify's own word survives, for the echo the session carries.
    expect(applied.selection.selection).toBe('subset');
    expect(applied.selection.reason).toBe('reduced_rerun');
  });

  it('runs the full suite when only part of the subset is collected', () => {
    // Identities, not counts: running the intersection would be a reduced run
    // over an arbitrary part of what was asked for, green on tests nobody
    // chose -- and it would look like an ordinary reduction.
    const applied = applyToCollected(served(['a', 'renamed']), ['a', 'b']);

    expect(applied.outcome).toBe('full');
    expect(applied.notAppliedReason).toBe('subset_partly_absent_from_collection');
    expect(applied.keptCount).toBe(2);
  });

  it('runs the full suite when the collection is empty', () => {
    const applied = applyToCollected(served(['a']), []);

    expect(applied.outcome).toBe('full');
    expect(applied.notAppliedReason).toBe('subset_matched_no_collected_test');
    expect(applied.keptCount).toBe(0);
  });

  it('passes a full selection straight through, keeping the whole collection', () => {
    const applied = applyToCollected(toTestSelection('full', 'no_predecessor', undefined), [
      'a',
      'b',
    ]);

    expect(applied.outcome).toBe('full');
    expect(applied.selection.reason).toBe('no_predecessor');
    expect(applied.notAppliedReason).toBeUndefined();
    expect(applied.keptCount).toBe(2);
    expect(applied.deselectedCount).toBe(0);
  });

  it('carries the answer-level reason of a subset served without tests', () => {
    const applied = applyToCollected(toTestSelection('subset', 'reduced_rerun', []), ['a']);

    expect(applied.outcome).toBe('full');
    expect(applied.notAppliedReason).toBe('subset_served_without_tests');
  });

  it('empties the run on an `empty` answer', () => {
    const applied = applyToCollected(toTestSelection('empty', 'queue_rerun', undefined), [
      'a',
      'b',
    ]);

    expect(applied.outcome).toBe('empty');
    expect(applied.keptCount).toBe(0);
    expect(applied.deselectedCount).toBe(2);
  });

  it('leaves the counters alone on an `empty` answer over an empty collection', () => {
    // A filter left nothing to run: the run is red for a reason of its own,
    // and an application recorded here would green that exit code.
    const applied = applyToCollected(toTestSelection('empty', 'queue_rerun', undefined), []);

    expect(applied.outcome).toBe('empty');
    expect(applied.deselectedCount).toBe(0);
  });

  it('refuses without touching the collection', () => {
    const applied = applyToCollected(
      toTestSelection('refused', 'ambiguous_test_sessions', undefined, 'several sessions'),
      ['a', 'b']
    );

    expect(applied.outcome).toBe('refused');
    expect(applied.keptCount).toBe(0);
    expect(applied.deselectedCount).toBe(0);
    expect(applied.selection.message).toBe('several sessions');
  });
});

describe('selectionEcho', () => {
  it('echoes the answer as served and what the run made of it', () => {
    const applied = applyToCollected(toTestSelection('subset', 'reduced_rerun', ['gone']), ['a']);

    expect(selectionEcho(applied)).toEqual({
      answer: 'subset',
      reason: 'reduced_rerun',
      kept_count: 1,
      not_applied_reason: 'subset_matched_no_collected_test',
    });
  });

  it('omits the not-applied key when the answer was honoured', () => {
    const applied = applyToCollected(toTestSelection('subset', 'reduced_rerun', ['a']), ['a', 'b']);

    expect(selectionEcho(applied)).toEqual({
      answer: 'subset',
      reason: 'reduced_rerun',
      kept_count: 1,
    });
  });

  it('echoes nothing when Mergify never answered', () => {
    // A `full` recorded for a run nobody looked at would make "we never
    // looked" and "we looked and chose not to reduce" indistinguishable.
    const failed: TestSelection = {
      selection: 'full',
      reason: 'fetch_failed',
      tests: new Set(),
      served: false,
      fetchError: 'HTTP 500',
    };

    expect(selectionEcho(applyToCollected(failed, ['a']))).toBeUndefined();
  });

  it('puts the collection on the resource with or without an echo', () => {
    expect(selectionResourceAttributes({ fingerprint: 'f1', count: 3 }, undefined)).toEqual({
      'test.collection.fingerprint': 'f1',
      'test.collection.count': 3,
    });
    expect(
      selectionResourceAttributes(
        { fingerprint: 'f1', count: 3 },
        { answer: 'empty', reason: 'queue_rerun', kept_count: 0, not_applied_reason: undefined }
      )
    ).toEqual({
      'test.collection.fingerprint': 'f1',
      'test.collection.count': 3,
      'test.selection.answer': 'empty',
      'test.selection.reason': 'queue_rerun',
      'test.selection.kept_count': 0,
    });
  });
});

// The block is pytest-mergify's, sentence for sentence: a developer reading
// a Playwright job log and a pytest job log must read the same prose. The
// expected strings below are copied from pytest-mergify's tests, not derived.
describe('formatTestSelectionReport', () => {
  const report = (selection: TestSelection, collected: string[]) =>
    formatTestSelectionReport(applyToCollected(selection, collected), CLIENT);

  it('describes a reduced rerun and lists what it re-executed', () => {
    const out = report(toTestSelection('subset', 'reduced_rerun', ['a', 'c']), ['a', 'b', 'c']);

    expect(out).toBe(
      '✂️ Test selection\n' +
        '\n' +
        "The code under test hasn't changed since the previous attempt of this job, where\n" +
        '2 of its 3 tests failed. Mergify re-executed only those 2 and skipped the 1 that\n' +
        'had already passed:\n' +
        '\n' +
        '  a\n' +
        '  c\n'
    );
  });

  it('says so when every collected test had failed', () => {
    const out = report(toTestSelection('subset', 'reduced_rerun', ['a']), ['a']);

    expect(out).toContain(
      "The code under test hasn't changed since the previous attempt of this job, where\nits only test failed. Mergify re-executed it:"
    );
  });

  it('caps the listed tests at ten and counts the rest', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const out = report(toTestSelection('subset', 'reduced_rerun', ids), ids);

    expect(out).toContain('  t9\n  … and 2 more\n');
    expect(out).not.toContain('  t10\n');
  });

  it('describes an empty run as green by design', () => {
    const out = report(toTestSelection('empty', 'queue_rerun', undefined), ['a', 'b']);

    expect(out).toBe(
      '✂️ Test selection\n' +
        '\n' +
        "The code under test hasn't changed since the previous attempt of this job, and\n" +
        'all 2 tests passed back then. Mergify skipped them: the job is green, and no\n' +
        'test was executed.\n'
    );
  });

  it('prints the title alone when an empty answer met an empty collection', () => {
    expect(report(toTestSelection('empty', 'queue_rerun', undefined), [])).toBe(
      '✂️ Test selection\n'
    );
  });

  it('points at the error above on a refusal', () => {
    const out = report(toTestSelection('refused', 'ambiguous_test_sessions', undefined, 'x'), [
      'a',
    ]);

    expect(out).toBe(
      '✂️ Test selection\n' +
        '\n' +
        'Mergify stopped this run before any test ran; its explanation is in the error\n' +
        'above.\n'
    );
  });

  it('translates every full-run reason into its sentence, never the identifier', () => {
    const sentence = (reason: string) =>
      report(toTestSelection('full', reason, undefined), ['a']).split('\n\n')[1];

    expect(sentence('no_predecessor')).toBe(
      'First attempt of this batch, so the full suite ran.\n'
    );
    expect(sentence('matched_test_session_incomplete')).toBe(
      'The previous attempt stopped before running all of its tests, so the full suite\nran.\n'
    );
    expect(sentence('matched_test_session_failures_truncated')).toBe(
      'The previous attempt had too many failures for Mergify to list, so the full\nsuite ran.\n'
    );
    expect(sentence('no_collection_fingerprint')).toBe(
      "This version of @mergifyio/playwright doesn't report what it collected, so the\n" +
        'full suite ran. Upgrade it to let Mergify reduce reruns.\n'
    );
    expect(sentence('feature_disabled')).toBe(
      "Test selection isn't enabled for this organization yet, so the full suite ran.\n"
    );
    expect(sentence('a_reason_this_client_predates')).toBe('Mergify served the full suite.\n');
    expect(
      report(toTestSelection('full', 'a_reason_this_client_predates', undefined), ['a'])
    ).not.toContain('a_reason_this_client_predates');
  });

  it('keys the sentence on what the run did with an answer it declined', () => {
    // Mergify's reason describes the answer that was NOT applied and would
    // read as a reduction.
    const out = report(toTestSelection('subset', 'reduced_rerun', ['gone']), ['a']);

    expect(out).toContain(
      "Mergify's answer didn't match the tests this run collected, so the full suite\nran."
    );
    expect(out).not.toContain('reduced_rerun');
  });

  it('names this client in the sentence about an answer it does not understand', () => {
    const out = report(toTestSelection('bisect', 'new_reason', undefined), ['a']);

    expect(out).toContain(
      "Mergify answered in a way this version of @mergifyio/playwright doesn't\n" +
        'understand, so the full suite ran. Upgrade it to let Mergify reduce reruns.'
    );
  });

  it('keeps the error text on its own line when the request failed', () => {
    const failed: TestSelection = {
      selection: 'full',
      reason: 'fetch_failed',
      tests: new Set(),
      served: false,
      fetchError: 'Mergify API returned HTTP 500',
    };

    expect(report(failed, ['a'])).toBe(
      '✂️ Test selection\n' +
        '\n' +
        "Mergify couldn't be asked whether this run could be reduced, so the full suite\n" +
        'ran.\n' +
        'Error: Mergify API returned HTTP 500\n'
    );
  });

  it('says a dormant repository was not offered anything', () => {
    const dormant: TestSelection = {
      selection: 'full',
      reason: 'not_requested',
      tests: new Set(),
      served: false,
    };

    expect(report(dormant, ['a'])).toContain(
      "Test selection isn't available for this repository, so the full suite ran."
    );
  });
});

describe('fallbackRefusalMessage', () => {
  it('links the client documentation page', () => {
    const message = fallbackRefusalMessage(CLIENT);

    expect(message).toContain('Mergify Test Selection stopped this run.');
    expect(message).toContain(
      'MERGIFY_TEST_JOB_NAME:\nhttps://docs.mergify.com/ci-insights/test-frameworks/playwright/'
    );
  });
});
