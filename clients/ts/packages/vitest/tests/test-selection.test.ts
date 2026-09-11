import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MergifyApiClient } from '@mergifyio/ci-core';
import {
  InMemorySpanSink,
  isTestSelectionEnabled,
  TEST_SELECTION_ENABLE_ENV,
} from '@mergifyio/ci-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVitest } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

let markerDir: string;
let markerFile: string;

/**
 * Run the selection fixture and report which test bodies actually executed —
 * read from the marker file the fixture appends to, never from the session,
 * so a suppressed report cannot be mistaken for a skipped execution.
 */
async function runSelection(options: {
  testSelection?: string[];
  testNamePattern?: string;
}): Promise<{ reporter: MergifyReporter; sink: InMemorySpanSink; executed: string[] }> {
  const sink = new InMemorySpanSink();
  const reporter = new MergifyReporter({ sink, testSelection: options.testSelection });

  const vitest = await startVitest('test', [], {
    root: fixturesDir,
    include: ['selection.test.ts'],
    reporters: [reporter],
    watch: false,
    ...(options.testNamePattern ? { testNamePattern: options.testNamePattern } : {}),
  });
  await vitest?.close();

  const executed = existsSync(markerFile)
    ? readFileSync(markerFile, 'utf8').split('\n').filter(Boolean).sort()
    : [];
  return { reporter, sink, executed };
}

/** Everything the run wrote to stdout -- the Vitest logger's channel -- while `run` was in flight. */
async function capturingStdout(run: () => Promise<unknown>): Promise<string> {
  const written: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    await run();
  } finally {
    stdout.mockRestore();
  }
  return written.join('');
}

function uploadedNames(sink: InMemorySpanSink): string[] {
  return sink
    .getFinishedSpans()
    .map((span) => span.name)
    .filter((name) => name !== 'vitest session start')
    .sort();
}

describe('test selection', () => {
  beforeEach(() => {
    markerDir = mkdtempSync(join(tmpdir(), 'mergify-selection-'));
    markerFile = join(markerDir, 'executed.txt');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
    vi.stubEnv('MERGIFY_SELECTION_MARKER', markerFile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(markerDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('runs every test when no subset is served', async () => {
    const { executed } = await runSelection({});
    expect(executed).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('executes only the served subset', async () => {
    const { executed } = await runSelection({ testSelection: ['selection > beta'] });
    expect(executed).toEqual(['beta']);
  });

  it('prints the shared block, naming what re-ran (MRGFY-8978)', async () => {
    // The same prose as pytest-mergify and @mergifyio/playwright: what
    // happened, why the green is safe, and which tests re-ran -- never an
    // identifier such as `reduced_rerun`.
    const out = await capturingStdout(() => runSelection({ testSelection: ['selection > beta'] }));

    expect(out).toContain(
      '[@mergifyio/vitest] ✂️ Test selection\n' +
        '\n' +
        "The code under test hasn't changed since the previous attempt of this job, where\n" +
        '1 of its 3 tests failed. Mergify re-executed only that one and skipped the 2\n' +
        'that had already passed:\n' +
        '\n' +
        '  selection > beta\n'
    );
    expect(out).not.toContain('reduced_rerun');
    expect(out).not.toContain('reason:');
  });

  it('does not upload the deselected tests', async () => {
    const { reporter, sink } = await runSelection({ testSelection: ['selection > beta'] });

    // A test that never ran has no result to report — not even a skipped one.
    expect(uploadedNames(sink)).toEqual(['selection > beta']);
    expect(reporter.getSession()!.testCases.map((tc) => tc.function)).toEqual(['beta']);
    // Counted, not merely absent: the end-of-run report has to say how many
    // were removed, and "0 deselected" would hide the filter doing nothing.
    expect(reporter.getSelection().deselectedCount).toBe(2);
  });

  it('narrows the user filter instead of widening it', async () => {
    // The user asked for `gamma` only; the subset asks for `beta`. The
    // intersection is empty, so nothing runs — the union would have run both.
    let executed: string[] = [];
    const out = await capturingStdout(async () => {
      ({ executed } = await runSelection({
        testSelection: ['selection > beta'],
        testNamePattern: 'gamma',
      }));
    });
    expect(executed).toEqual([]);
    // And the block says that, rather than "0 of its 1 tests failed … skipped
    // the 1 that had already passed", which would be false twice over.
    expect(out).toContain(
      "Mergify asked to re-execute 1 test of this job's previous attempt, and your own filters excluded all of them, so none ran."
    );
    expect(out).not.toContain('0 of its');
  });

  it('keeps a test both the user and the subset asked for', async () => {
    const { reporter, executed } = await runSelection({
      testSelection: ['selection > beta', 'selection > gamma'],
      testNamePattern: 'gamma',
    });
    expect(executed).toEqual(['gamma']);
    // `beta` was served but the user's own filter removed it, so the run must
    // not claim to have replayed it.
    expect(reporter.getSelection().executedCount).toBe(1);
  });

  it('runs everything, and stays green, when the served subset is empty', async () => {
    // An empty subset means "nothing to replay" — a branch that was green, which
    // is what the server will send once it can say so. Taken literally it would
    // deselect every test and the stale-subset guard would then redden a branch
    // that never failed.
    const { reporter, executed } = await runSelection({ testSelection: [] });

    expect(executed).toEqual(['alpha', 'beta', 'gamma']);
    expect(reporter.getSelection().selection?.selection).toBe('full');
    expect(reporter.getSession()!.status).toBe('passed');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails the run when the subset matches nothing collected', async () => {
    // A stale subset (every name renamed since the predecessor) would otherwise
    // skip everything and report green, merging untested code.
    let result: Awaited<ReturnType<typeof runSelection>> | undefined;
    const out = await capturingStdout(async () => {
      result = await runSelection({
        testSelection: ['selection > renamed-since-the-predecessor'],
      });
    });

    expect(result!.executed).toEqual([]);
    expect(result!.reporter.getSession()!.status).toBe('failed');
    expect(process.exitCode).toBe(1);
    // The deliberate failure is the explanation; a block claiming "0 of its 3
    // tests failed … skipped the 3 that had already passed" right above it
    // would contradict it.
    expect(out).not.toContain('✂️ Test selection');
  });

  it('never uploads a deselected test, whatever state it carries', async () => {
    // End-to-end, a deselected test arrives `pending` and the pre-existing
    // pending guard would drop it anyway — which means the integration test
    // above cannot tell a working suppression from a missing one. Vitest
    // assigns `skipped` (not `pending`) to tests IT skips, so the day that
    // changes for ours, only this test notices.
    const reporter = new MergifyReporter({ testSelection: ['selection > beta'] });
    await reporter.onTestRunStart();

    const deselected = {
      fullName: 'selection > alpha',
      name: 'alpha',
      location: { line: 1, column: 1 },
      module: { relativeModuleId: 'selection.test.ts', moduleId: '/selection.test.ts' },
      meta: () => ({ mergifyDeselected: true }),
      result: () => ({ state: 'skipped' as const }),
      diagnostic: () => undefined,
    };
    reporter.onTestCaseResult(
      deselected as unknown as Parameters<MergifyReporter['onTestCaseResult']>[0]
    );

    expect(reporter.getSession()!.testCases).toEqual([]);
    expect(reporter.getSelection().deselectedCount).toBe(1);
  });

  it('matches the identifiers the reporter uploads', async () => {
    // The subset is matched against the same string the client uploads, so a
    // name taken from a previous run's upload always matches. This is the
    // round-trip the two must agree on.
    const first = await runSelection({});
    const uploaded = uploadedNames(first.sink);

    rmSync(markerFile, { force: true });
    const second = await runSelection({ testSelection: [uploaded[1]] });

    expect(uploaded).toEqual(['selection > alpha', 'selection > beta', 'selection > gamma']);
    expect(second.executed).toEqual(['beta']);
  });
});

/**
 * A stand-in for the bundled client, so the gate can be watched at the seam it
 * guards. Injected rather than mocked at module level: what has to be pinned is
 * that the reporter never *calls*, and only a client it actually holds can tell
 * the difference between "did not call" and "had nobody to call".
 */
function stubApiClient(): MergifyApiClient {
  return {
    fetchQuarantine: vi.fn().mockResolvedValue(null),
    fetchFlakyContext: vi.fn().mockResolvedValue(null),
    fetchTestSelection: vi.fn().mockResolvedValue(null),
    uploadTrace: vi.fn().mockResolvedValue(undefined),
  };
}

async function runWith(apiClient: MergifyApiClient): Promise<void> {
  const reporter = new MergifyReporter({ sink: new InMemorySpanSink(), apiClient });
  const vitest = await startVitest('test', [], {
    root: fixturesDir,
    include: ['selection.test.ts'],
    reporters: [reporter],
    watch: false,
  });
  await vitest?.close();
}

describe('the opt-in gate', () => {
  beforeEach(() => {
    markerDir = mkdtempSync(join(tmpdir(), 'mergify-selection-'));
    markerFile = join(markerDir, 'executed.txt');
    vi.stubEnv('MERGIFY_SELECTION_MARKER', markerFile);
    // A CI whose job coordinates are complete: without all four there is
    // nothing to ask, and every assertion below would pass for that reason
    // instead of for the gate.
    //
    // `GITHUB_EVENT_NAME` comes first because it decides where the rest is
    // read from: on a `pull_request` event the core takes the head revision
    // from the event payload rather than from GITHUB_SHA, which there is the
    // merge commit (`crates/mergify-ci-core/src/providers/github_actions.rs`).
    // This suite runs inside such a job on our own CI, so without this line
    // the stubbed SHA below is ignored and the real one arrives instead —
    // green locally, red in CI.
    vi.stubEnv('GITHUB_EVENT_NAME', 'push');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
    vi.stubEnv('GITHUB_HEAD_REF', '');
    vi.stubEnv('GITHUB_REF_NAME', 'queue/main/42');
    vi.stubEnv('GITHUB_SHA', 'cafecafe');
    vi.stubEnv('GITHUB_WORKFLOW', 'CI');
    vi.stubEnv('GITHUB_JOB', 'unit');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(markerDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('asks for nothing when the job did not opt in', async () => {
    // The property MRGFY-9172 rests on: a job that never opted in leaves no
    // selection answer on its session, which is how Mergify tells a repository
    // that has not asked from one that has. Asking in order to be told "not
    // opted in" would answer that question everywhere and erase it.
    const apiClient = stubApiClient();

    await runWith(apiClient);

    expect(apiClient.fetchTestSelection).not.toHaveBeenCalled();
    // The opt-in gates this feature alone, not the reporting a repository
    // already pays for.
    expect(apiClient.fetchQuarantine).toHaveBeenCalled();
  });

  it("asks, with the run's own coordinates, when the job opted in", async () => {
    vi.stubEnv(TEST_SELECTION_ENABLE_ENV, 'true');
    const apiClient = stubApiClient();

    await runWith(apiClient);

    expect(apiClient.fetchTestSelection).toHaveBeenCalledWith(
      'queue/main/42',
      'cafecafe',
      'CI',
      'unit'
    );
  });

  it('says why the full suite ran when Mergify answered so (MRGFY-8978)', async () => {
    // A developer whose run was NOT reduced is the one asking why: the block
    // is printed on a full answer too, with the sentence for its reason and
    // never the identifier.
    vi.stubEnv(TEST_SELECTION_ENABLE_ENV, 'true');
    const apiClient = stubApiClient();
    (apiClient.fetchTestSelection as ReturnType<typeof vi.fn>).mockResolvedValue({
      selection: 'full',
      reason: 'no_predecessor',
    });

    const out = await capturingStdout(() => runWith(apiClient));

    expect(out).toContain(
      '[@mergifyio/vitest] ✂️ Test selection\n\nFirst attempt of this batch, so the full suite ran.\n'
    );
    expect(out).not.toContain('no_predecessor');
  });

  it('says an answer it does not understand is one to upgrade for', async () => {
    // An `empty` answer -- the engine's, once a fingerprint is sent -- is one
    // this version predates: the run stays full and the block says so.
    vi.stubEnv(TEST_SELECTION_ENABLE_ENV, 'true');
    const apiClient = stubApiClient();
    (apiClient.fetchTestSelection as ReturnType<typeof vi.fn>).mockResolvedValue({
      selection: 'empty',
      reason: 'matched_test_session_had_no_gating_failure',
    });

    const out = await capturingStdout(() => runWith(apiClient));

    expect(out).toContain(
      "Mergify answered in a way this version of @mergifyio/vitest doesn't understand"
    );
    expect(out).not.toContain('matched_test_session_had_no_gating_failure');
  });

  it('stays silent when the repository is dormant', async () => {
    vi.stubEnv(TEST_SELECTION_ENABLE_ENV, 'true');
    const out = await capturingStdout(() => runWith(stubApiClient()));
    expect(out).not.toContain('✂️ Test selection');
  });

  it.each([
    'false',
    '',
    'perhaps',
    ' ',
  ])('asks for nothing on %j, which is not a yes', async (value) => {
    vi.stubEnv(TEST_SELECTION_ENABLE_ENV, value);
    const apiClient = stubApiClient();

    await runWith(apiClient);

    expect(apiClient.fetchTestSelection).not.toHaveBeenCalled();
  });

  it('is on for a yes a workflow author would plausibly write', () => {
    // Kept as a unit assertion next to the ones above: the values themselves
    // are the core's business, and driving a whole Vitest run per spelling
    // would buy nothing.
    for (const yes of ['1', 'true', 'yes', 'on', 'TRUE', ' true ']) {
      expect(isTestSelectionEnabled(yes)).toBe(true);
    }
  });
});
