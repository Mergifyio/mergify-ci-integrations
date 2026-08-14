import { describe, expect, it, vi } from 'vitest';
import {
  fetchTestSelection,
  isTestSelectionDisabled,
  resolveSelectionCoordinates,
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
