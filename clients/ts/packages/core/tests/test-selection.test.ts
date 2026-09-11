import { describe, expect, it, vi } from 'vitest';
import {
  applyToCollected,
  fetchTestSelection,
  formatTestSelectionReport,
  isTestSelectionEnabled,
  outcomeOfApplication,
  resolveSelectionCoordinates,
  TEST_SELECTION_ENABLE_ENV,
  type TestSelection,
  type TestSelectionClient,
  type TestSelectionOutcome,
} from '../src/test-selection.js';

// HTTP status handling (402/404 dormant, a `subset` missing its `tests` list
// surfaced as a failure) lives in the Rust client and is tested there. What
// remains here is the rule the whole feature rests on: everything that is not
// an explicit, non-empty subset must come out as "run the full suite".
function client(fetch: TestSelectionClient['fetchTestSelection']): TestSelectionClient {
  return { fetchTestSelection: fetch };
}

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
  });

  it('passes the run identity through to the client', async () => {
    const fetch = vi.fn().mockResolvedValue(null);

    await fetchTestSelection(client(fetch), COORDINATES, vi.fn());

    expect(fetch).toHaveBeenCalledWith('mergify/merge-queue/main', 'cafe1234', 'CI', 'unit');
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

    expect(selection.selection).toBe('full');
    expect(selection.tests.size).toBe(0);
    expect(selection.reason).toBe('subset_served_without_tests');
  });

  it.each([
    'empty',
    'refused',
    'a-shape-this-client-predates',
  ])('names a %s answer for what happened, not for what the server said', async (answer) => {
    // `empty` and `refused` are answers this client predates, and a newer
    // shape is the same case: the run stays full, and the reason lets the
    // end-of-run block lead to an upgrade rather than print the server's
    // reason for an answer that was not applied.
    const selection = await fetchTestSelection(
      client(async () => ({ selection: answer, reason: 'whatever_the_server_said' }) as never),
      COORDINATES,
      vi.fn()
    );
    expect(selection.selection).toBe('full');
    expect(selection.reason).toBe('unrecognised_selection');
  });

  it('runs everything when a subset arrives empty', async () => {
    // An empty list is "nothing to replay", never "run nothing" — reading it
    // the other way would turn the suite green without executing anything.
    const selection = await fetchTestSelection(
      client(async () => ({ selection: 'subset', reason: 'reduced_rerun', tests: [] })),
      COORDINATES,
      vi.fn()
    );

    expect(selection.selection).toBe('full');
    expect(selection.tests.size).toBe(0);
    // Named as the not-applied shape it is, never as the server's reason for
    // a subset this client did not honour.
    expect(selection.reason).toBe('subset_served_without_tests');
  });

  it('runs everything when the repository is dormant', async () => {
    const selection = await fetchTestSelection(
      client(async () => null),
      COORDINATES,
      vi.fn()
    );

    expect(selection.selection).toBe('full');
    expect(selection.reason).toBe('not_requested');
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
    // The error text on its own line, never wrapped into the sentence: what
    // support gets pasted must not be a split URL.
    expect(logger).toHaveBeenCalledWith(
      "Mergify couldn't be asked whether this run could be reduced, so the full suite will run.\nError: Mergify API returned HTTP 500"
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
  const subset = (tests: string[]): TestSelection => ({
    selection: 'subset',
    reason: 'queue_rerun',
    tests: new Set(tests),
  });

  it('keeps the served tests and deselects the rest', () => {
    const applied = applyToCollected(subset(['b', 'd']), ['a', 'b', 'c', 'd']);

    expect(applied.selection).toBe('subset');
    expect(applied.reason).toBe('queue_rerun');
    expect([...applied.keep]).toEqual(['b', 'd']);
    expect(applied.keptCount).toBe(2);
    expect(applied.deselectedCount).toBe(2);
  });

  it('ignores served names the collection does not have', () => {
    const applied = applyToCollected(subset(['b', 'renamed-away']), ['a', 'b']);

    expect(applied.selection).toBe('subset');
    expect([...applied.keep]).toEqual(['b']);
    expect(applied.keptCount).toBe(1);
    expect(applied.deselectedCount).toBe(1);
  });

  it('runs the full suite when the served subset matches nothing', () => {
    // The filet against a stale set: every served name was renamed since the
    // previous attempt, and a reduced run would turn green testing nothing.
    const applied = applyToCollected(subset(['old-name-1', 'old-name-2']), ['a', 'b']);

    expect(applied.selection).toBe('full');
    expect(applied.reason).toBe('subset_matched_no_collected_test');
    expect(applied.keep.size).toBe(0);
  });

  it('runs the full suite when the collection is empty', () => {
    const applied = applyToCollected(subset(['a']), []);

    expect(applied.selection).toBe('full');
    expect(applied.reason).toBe('subset_matched_no_collected_test');
  });

  it('passes a full selection straight through', () => {
    const applied = applyToCollected(
      { selection: 'full', reason: 'not_requested', tests: new Set([]) },
      ['a', 'b']
    );

    expect(applied.selection).toBe('full');
    expect(applied.reason).toBe('not_requested');
    expect(applied.keep.size).toBe(0);
  });

  it('counts a name collected several times once per occurrence', () => {
    // A Playwright test caught in two projects shares one identity but is two
    // collected entries; the counts must still add up to what actually runs.
    const applied = applyToCollected(subset(['b']), ['a', 'b', 'b', 'c']);

    expect(applied.keptCount).toBe(2);
    expect(applied.deselectedCount).toBe(2);
  });

  it('counts every occurrence exactly once over a long collection', () => {
    // Guards the single-pass rewrite: an earlier version counted `keptCount` in
    // a second pass over the same parameter, which a lazy caller would have
    // exhausted. Counting must stay consistent with `deselectedCount`.
    const collected = ['a', 'b', 'c', 'b', 'd', 'b'];
    const applied = applyToCollected(subset(['b']), collected);

    expect(applied.keptCount).toBe(3);
    expect(applied.deselectedCount).toBe(3);
    expect(applied.keptCount + applied.deselectedCount).toBe(collected.length);
  });
});

// --- The end-of-run block (MRGFY-8978) ---
//
// The same prose as pytest-mergify's `report()`: the three clients say the
// same thing. The wording was validated by Alexandre on 2026-09-11 and is
// pinned verbatim on purpose -- a change to it is a product decision, not a
// refactor -- and no internal identifier may ever reach it.

// Every identifier the engine or this client can put in `reason`. The last
// test of this block renders every path and greps for each of these.
const ENGINE_FULL_REASONS = [
  'feature_disabled',
  'not_a_merge_queue_run',
  'stale_run',
  'no_predecessor',
  'predecessor_unknown',
  'no_collection_fingerprint',
  'no_matching_test_session',
  'indeterminate_test_session',
  'matched_test_session_partially_processed',
  'matched_test_session_dropped_cases',
  'matched_test_session_declaration_unreadable',
  'matched_test_session_ran_no_test',
];
const CLIENT_FULL_REASONS = [
  'not_requested',
  'fetch_failed',
  'unrecognised_selection',
  'subset_served_without_tests',
  'subset_matched_no_collected_test',
];
const EVERY_REASON = [
  ...ENGINE_FULL_REASONS,
  ...CLIENT_FULL_REASONS,
  'reduced_rerun',
  'matched_test_session_had_no_gating_failure',
  'ambiguous_test_sessions',
];

// The table from the ticket, one row per engine reason; `{client}` where the
// sentence names the package.
const ENGINE_SENTENCES: ReadonlyArray<[string, string]> = [
  ['no_predecessor', 'First attempt of this batch, so the full suite ran.'],
  ['not_a_merge_queue_run', "This job isn't part of a merge queue run, so the full suite ran."],
  ['stale_run', 'The batch branch was updated while this job was running, so the full suite ran.'],
  [
    'no_matching_test_session',
    "The previous attempt didn't run this exact set of tests, so the full suite ran.",
  ],
  [
    'matched_test_session_ran_no_test',
    'The previous attempt executed no tests, so the full suite ran.',
  ],
  [
    'predecessor_unknown',
    "Mergify couldn't tell which previous run to start from, so the full suite ran.",
  ],
  [
    'indeterminate_test_session',
    "Mergify couldn't tell which previous run to start from, so the full suite ran.",
  ],
  [
    'matched_test_session_partially_processed',
    "Mergify didn't have the complete results of the previous attempt, so the full suite ran.",
  ],
  [
    'matched_test_session_dropped_cases',
    "Mergify didn't have the complete results of the previous attempt, so the full suite ran.",
  ],
  [
    'matched_test_session_declaration_unreadable',
    "Mergify didn't have the complete results of the previous attempt, so the full suite ran.",
  ],
  [
    'no_collection_fingerprint',
    "@mergifyio/vitest doesn't report what it collected yet, so the full suite ran.",
  ],
  [
    'feature_disabled',
    "Test selection isn't enabled for this organization yet, so the full suite ran.",
  ],
];

function servedSubset(served: string[], collected: string[]): TestSelectionOutcome {
  return outcomeOfApplication(
    applyToCollected(
      { selection: 'subset', reason: 'reduced_rerun', tests: new Set(served) },
      collected
    )
  );
}

function fullRun(reason: string): TestSelectionOutcome {
  return { selection: 'full', reason, reExecuted: [], reExecutedCount: 0, skipped: 0 };
}

/** Greedy 80-column wrap at spaces, the same rule the block applies -- so a test can state a sentence once. */
function wrapped(sentence: string): string {
  const lines: string[] = [];
  let line = '';
  for (const word of sentence.split(' ')) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= 80) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines.join('\n');
}

describe('formatTestSelectionReport', () => {
  it('lists what was re-executed, verbatim from the ticket', () => {
    const failed = [
      'tests/suite/test_checkout.py::test_checkout_rejects_negative_quantity_07',
      'tests/suite/test_checkout.py::test_checkout_total_02',
      'tests/suite/test_payment.py::test_refund_partial',
    ];
    const collected = [
      ...failed,
      ...Array.from({ length: 321 }, (_, i) => `tests/suite/test_other.py::test_${i}`),
    ];

    expect(formatTestSelectionReport(servedSubset(failed, collected), '@mergifyio/vitest')).toBe(
      '✂️ Test selection\n' +
        '\n' +
        "The code under test hasn't changed since the previous attempt of this job, where\n" +
        '3 of its 324 tests failed. Mergify re-executed only those 3 and skipped the 321\n' +
        'that had already passed:\n' +
        '\n' +
        '  tests/suite/test_checkout.py::test_checkout_rejects_negative_quantity_07\n' +
        '  tests/suite/test_checkout.py::test_checkout_total_02\n' +
        '  tests/suite/test_payment.py::test_refund_partial\n'
    );
  });

  it('lists only what was collected, and says "that one" for a single test', () => {
    const report = formatTestSelectionReport(
      servedSubset(['a > kept', 'gone > renamed'], ['a > kept', 'a > fine']),
      '@mergifyio/vitest'
    );
    expect(report).toContain('  a > kept\n');
    expect(report).not.toContain('renamed');
    expect(report).toContain(
      '1 of its 2 tests failed. Mergify re-executed only that one and skipped'
    );
  });

  it('caps the list at ten names, and never says "and 0 more"', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `x > t${String(i).padStart(2, '0')}`);
    const capped = formatTestSelectionReport(
      servedSubset(twelve, [...twelve, 'y > fine']),
      '@mergifyio/vitest'
    );
    const listed = capped.split('\n').filter((line) => line.startsWith('  '));
    expect(listed).toEqual([...twelve.slice(0, 10).map((name) => `  ${name}`), '  … and 2 more']);

    const ten = twelve.slice(0, 10);
    const exact = formatTestSelectionReport(
      servedSubset(ten, [...ten, 'y > fine']),
      '@mergifyio/vitest'
    );
    expect(exact).not.toContain('more');
    expect(exact.split('\n').filter((line) => line.startsWith('  ')).length).toBe(10);
  });

  it('says nothing about skipping when every collected test had failed', () => {
    const two = formatTestSelectionReport(
      servedSubset(['a', 'b'], ['a', 'b']),
      '@mergifyio/vitest'
    );
    expect(two).toContain('all 2 of its tests failed. Mergify re-executed all of them:');
    expect(two).not.toContain('skipped');

    const one = formatTestSelectionReport(servedSubset(['a'], ['a']), '@mergifyio/vitest');
    expect(one).toContain('its only test failed. Mergify re-executed it:');
    expect(one).not.toContain('1 of its');
  });

  it.each(ENGINE_SENTENCES)('says why the full suite ran: %s', (reason, sentence) => {
    expect(formatTestSelectionReport(fullRun(reason), '@mergifyio/vitest')).toBe(
      `✂️ Test selection\n\n${wrapped(sentence)}\n`
    );
  });

  it('has a sentence for every reason the engine can serve', () => {
    // The table above IS the contract; this pins that it names every reason
    // the engine can serve as of this change, so one added to the test list
    // without a sentence is caught here rather than in a customer's log.
    expect(new Set(ENGINE_SENTENCES.map(([reason]) => reason))).toEqual(
      new Set(ENGINE_FULL_REASONS)
    );
  });

  it('names the package the sentence is about', () => {
    expect(
      formatTestSelectionReport(fullRun('no_collection_fingerprint'), '@mergifyio/playwright')
    ).toContain("@mergifyio/playwright doesn't report what it collected yet");
  });

  it("tells an answer this client predates apart from one it couldn't apply", () => {
    // Two remedies: a `selection` this version predates is the user's to fix
    // by upgrading; a subset naming no test, or none this run collected, is
    // ours to see in our own data, and asks nothing of the reader.
    const older = formatTestSelectionReport(fullRun('unrecognised_selection'), '@mergifyio/vitest');
    expect(older).toContain("Mergify answered in a way this version of @mergifyio/vitest doesn't");
    expect(older).toContain('Upgrade it to let Mergify reduce reruns.');

    for (const reason of ['subset_served_without_tests', 'subset_matched_no_collected_test']) {
      const report = formatTestSelectionReport(fullRun(reason), '@mergifyio/vitest');
      expect(report).toContain(
        "Mergify's answer didn't match the tests this run collected, so the full"
      );
      expect(report).not.toContain('Upgrade');
    }
  });

  it('says the request failed without repeating the error', () => {
    // The error itself was logged when the fetch failed, on its own line.
    expect(formatTestSelectionReport(fullRun('fetch_failed'), '@mergifyio/vitest')).toBe(
      "✂️ Test selection\n\nMergify couldn't be asked whether this run could be reduced, so the full suite\nran.\n"
    );
  });

  it('still reads as a full run on a reason this client predates', () => {
    expect(
      formatTestSelectionReport(fullRun('a_reason_this_client_predates'), '@mergifyio/vitest')
    ).toBe('✂️ Test selection\n\nMergify served the full suite.\n');
  });

  it('never lets an internal identifier, a label, or a call to support reach the terminal', () => {
    const rendered = [
      ...[...ENGINE_FULL_REASONS, ...CLIENT_FULL_REASONS, 'unknown'].map((reason) =>
        formatTestSelectionReport(fullRun(reason), '@mergifyio/vitest')
      ),
      formatTestSelectionReport(servedSubset(['a', 'b'], ['a', 'b', 'c']), '@mergifyio/vitest'),
    ];
    for (const text of rendered) {
      for (const identifier of EVERY_REASON) expect(text).not.toContain(identifier);
      expect(text).not.toContain('reason:');
      expect(text.toLowerCase()).not.toContain('selection:');
      // Alexandre, 2026-09-11: the shapes a correct engine cannot produce are
      // ours to see in our own data; asking the customer to report them hands
      // them our work.
      expect(text.toLowerCase()).not.toContain('support');
      expect(text.toLowerCase()).not.toContain('report it');
      expect(text).not.toContain('{client}');
    }
  });

  it('never wraps a paragraph inside a word or at a hyphen', () => {
    // The wrap is greedy at spaces only; a test name is listed on its own
    // line, never through the wrap.
    const longName = `suite > ${'x'.repeat(120)}`;
    const report = formatTestSelectionReport(
      servedSubset([longName], [longName, 'y']),
      '@mergifyio/vitest'
    );
    expect(report).toContain(`  ${longName}\n`);
    for (const line of report.split('\n')) expect(line.endsWith('-')).toBe(false);
  });
});
