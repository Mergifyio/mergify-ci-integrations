import { describe, expect, it, vi } from 'vitest';
import type { MergifyApiClient } from '../src/api.js';
import {
  applyToCollected,
  formatTestSelectionReport,
  isTestSelectionDisabled,
  resolveTestSelection,
  resolveTestSelectionCoordinates,
  type TestSelection,
} from '../src/test-selection.js';

const COORDINATES = {
  branch: 'mergify/merge-queue/main',
  headSha: 'cafe1234',
  pipelineName: 'CI',
  jobName: 'unit',
};

// Status handling (402/404 dormant, everything else surfaced) lives in the Rust
// client and is tested there. What is left here is the degradation contract:
// every outcome that is not an actionable subset must run the full suite.
function client(fetchTestSelectionImpl: MergifyApiClient['fetchTestSelection']): MergifyApiClient {
  return {
    fetchQuarantine: vi.fn(),
    fetchFlakyContext: vi.fn(),
    fetchTestSelection: fetchTestSelectionImpl,
    uploadTrace: vi.fn(),
  };
}

describe('resolveTestSelectionCoordinates', () => {
  const complete = {
    'vcs.ref.head.name': 'mergify/merge-queue/main',
    'vcs.ref.head.revision': 'cafe1234',
    'cicd.pipeline.name': 'CI',
    'cicd.pipeline.task.name': 'unit',
  };

  it('keys the request on the run own head branch and revision', () => {
    expect(resolveTestSelectionCoordinates(complete)).toEqual(COORDINATES);
  });

  it('prefers the MERGIFY_TEST_JOB_NAME override over the provider task name', () => {
    expect(
      resolveTestSelectionCoordinates({ ...complete, 'mergify.test.job.name': 'unit (3.13)' })
    ).toEqual({ ...COORDINATES, jobName: 'unit (3.13)' });
  });

  it.each(Object.keys(complete))('does not ask when %s is missing', (missing) => {
    const attrs = { ...complete, [missing]: undefined };
    expect(resolveTestSelectionCoordinates(attrs)).toBeNull();
  });

  it('treats an empty attribute as missing', () => {
    expect(
      resolveTestSelectionCoordinates({ ...complete, 'vcs.ref.head.revision': '' })
    ).toBeNull();
  });

  it('ignores a base ref: the selection is keyed on the head, not the PR target', () => {
    expect(resolveTestSelectionCoordinates({ ...complete, 'vcs.ref.base.name': 'main' })).toEqual(
      COORDINATES
    );
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

describe('resolveTestSelection', () => {
  it('passes the run coordinates through to the client', async () => {
    const fetch = vi.fn().mockResolvedValue(null);

    await resolveTestSelection(client(fetch), COORDINATES, vi.fn());

    expect(fetch).toHaveBeenCalledWith('mergify/merge-queue/main', 'cafe1234', 'CI', 'unit');
  });

  it('returns the served subset', async () => {
    const logger = vi.fn();

    const selection = await resolveTestSelection(
      client(async () => ({
        selection: 'subset',
        reason: 'queue_rerun',
        tests: ['a.spec.ts > x', 'a.spec.ts > y'],
      })),
      COORDINATES,
      logger
    );

    expect(selection).toEqual({
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['a.spec.ts > x', 'a.spec.ts > y'],
    });
    expect(logger).not.toHaveBeenCalled();
  });

  it('serves nothing at all when the feature is dormant', async () => {
    // Null, not a `full` selection: nothing was served, so the reporter has
    // nothing to report. A repository without the subscription must not gain a
    // Mergify block on every CI run.
    const logger = vi.fn();

    const selection = await resolveTestSelection(
      client(async () => null),
      COORDINATES,
      logger
    );

    expect(selection).toBeNull();
    expect(logger).not.toHaveBeenCalled();
  });

  it('runs everything and logs when the fetch fails', async () => {
    const logger = vi.fn();

    const selection = await resolveTestSelection(
      client(async () => {
        throw new Error('Mergify API request timed out');
      }),
      COORDINATES,
      logger
    );

    expect(selection).toEqual({ selection: 'full', reason: 'fetch_failed', tests: [] });
    expect(logger).toHaveBeenCalledWith(
      'Failed to fetch the test selection, the full test suite will run: Mergify API request timed out'
    );
  });

  it('runs everything on a subset the server sent empty', async () => {
    const selection = await resolveTestSelection(
      client(async () => ({ selection: 'subset', reason: 'nothing_failed', tests: [] })),
      COORDINATES,
      vi.fn()
    );

    expect(selection).toEqual({ selection: 'full', reason: 'nothing_failed', tests: [] });
  });

  it('runs everything on an unknown selection value', async () => {
    const selection = await resolveTestSelection(
      client(async () => ({ selection: 'someday', reason: 'from_the_future', tests: ['a'] })),
      COORDINATES,
      vi.fn()
    );

    expect(selection).toEqual({ selection: 'full', reason: 'from_the_future', tests: [] });
  });

  it('drops the tests a `full` answer carried anyway', async () => {
    const selection = await resolveTestSelection(
      client(async () => ({ selection: 'full', reason: 'not_a_rerun', tests: ['a.spec.ts > x'] })),
      COORDINATES,
      vi.fn()
    );

    expect(selection).toEqual({ selection: 'full', reason: 'not_a_rerun', tests: [] });
  });
});

describe('applyToCollected', () => {
  const subset = (tests: string[]): TestSelection => ({
    selection: 'subset',
    reason: 'queue_rerun',
    tests,
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
    const applied = applyToCollected({ selection: 'full', reason: 'not_requested', tests: [] }, [
      'a',
      'b',
    ]);

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
      applyToCollected({ selection: 'subset', reason: 'queue_rerun', tests: ['b'] }, [
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
      applyToCollected({ selection: 'subset', reason: 'queue_rerun', tests: ['gone'] }, ['a'])
    );

    expect(report).toBe(
      '✂️ Test selection\n  selection: full (reason: subset_matched_no_collected_test)\n'
    );
  });
});
