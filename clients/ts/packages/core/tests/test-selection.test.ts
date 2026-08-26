import { describe, expect, it, vi } from 'vitest';
import {
  applyToCollected,
  fetchTestSelection,
  formatTestSelectionReport,
  isTestSelectionDisabled,
  resolveSelectionCoordinates,
  type TestSelection,
  type TestSelectionClient,
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

describe('isTestSelectionDisabled', () => {
  it('is off by default', () => {
    vi.stubEnv('MERGIFY_TEST_SELECTION_DISABLE', undefined);
    expect(isTestSelectionDisabled()).toBe(false);
    vi.unstubAllEnvs();
  });

  it.each(['1', 'true', 'yes'])('is on for %s', (value) => {
    vi.stubEnv('MERGIFY_TEST_SELECTION_DISABLE', value);
    expect(isTestSelectionDisabled()).toBe(true);
    vi.unstubAllEnvs();
  });

  it('disables on an unparsable value rather than crashing the run', () => {
    vi.stubEnv('MERGIFY_TEST_SELECTION_DISABLE', 'maybe');
    expect(isTestSelectionDisabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe('isTestSelectionDisabled', () => {
  it('is enabled when the kill switch is unset', () => {
    expect(isTestSelectionDisabled(undefined)).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on'])('is disabled by %s', (value) => {
    expect(isTestSelectionDisabled(value)).toBe(true);
  });

  it.each(['false', '0', 'no', 'off'])('stays enabled on %s', (value) => {
    expect(isTestSelectionDisabled(value)).toBe(false);
  });

  it('reads an unparsable value as an attempt to disable', () => {
    expect(isTestSelectionDisabled('maybe')).toBe(true);
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

describe('formatTestSelectionReport', () => {
  it('reports the reduction with both counts', () => {
    const report = formatTestSelectionReport(
      applyToCollected({ selection: 'subset', reason: 'queue_rerun', tests: new Set(['b']) }, [
        'a',
        'b',
        'c',
      ])
    );

    expect(report).toBe(
      '✂️ Test selection\n  selection: subset (reason: queue_rerun)\n  reduced rerun: executing 1 previously-failing test(s), 2 deselected\n'
    );
  });

  it('reports why the full suite is running', () => {
    const report = formatTestSelectionReport(
      applyToCollected({ selection: 'subset', reason: 'queue_rerun', tests: new Set(['gone']) }, [
        'a',
      ])
    );

    expect(report).toBe(
      '✂️ Test selection\n  selection: full (reason: subset_matched_no_collected_test)\n'
    );
  });
});
