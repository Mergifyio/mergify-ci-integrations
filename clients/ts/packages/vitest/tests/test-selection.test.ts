import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import type { MergifyApiClient, SessionVerdictClient } from '@mergifyio/ci-core';
import {
  InMemorySpanSink,
  isTestSelectionEnabled,
  TEST_SELECTION_ENABLE_ENV,
} from '@mergifyio/ci-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestSpecification, Vitest } from 'vitest/node';
import { startVitest } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';
import { selectionUnreachable } from '../src/test-selection.js';

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
    const { executed } = await runSelection({
      testSelection: ['selection > beta'],
      testNamePattern: 'gamma',
    });
    expect(executed).toEqual([]);
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
    // The answer is kept as served and the run declares why it did not act on
    // it, rather than rewriting Mergify's word into a `full` it never said.
    expect(reporter.getSelection().selection?.selection).toBe('subset');
    expect(reporter.getSelection().selection?.notAppliedReason).toBe('subset_served_without_tests');
    expect(reporter.getSession()!.status).toBe('passed');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails the run when the subset matches nothing collected', async () => {
    // A stale subset (every name renamed since the predecessor) would otherwise
    // skip everything and report green, merging untested code.
    const { reporter, executed } = await runSelection({
      testSelection: ['selection > renamed-since-the-predecessor'],
    });

    expect(executed).toEqual([]);
    expect(reporter.getSession()!.status).toBe('failed');
    expect(process.exitCode).toBe(1);
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

    // With the fingerprint of the files this run executes: without one the
    // engine answers `full` whatever the previous attempt did.
    expect(apiClient.fetchTestSelection).toHaveBeenCalledWith(
      'queue/main/42',
      'cafecafe',
      'CI',
      'unit',
      expect.stringMatching(/^[0-9a-f]{64}$/)
    );
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

type SessionVerdict = Parameters<SessionVerdictClient['sendSessionVerdict']>[0];

/** A served answer, as the bundled client returns it. */
interface Answer {
  selection: string;
  reason: string;
  tests?: string[];
  message?: string;
}

/**
 * Drive one opted-in run end to end against a stand-in for the backend: the
 * request it makes, the tests it executes, the verdict it writes, the resource
 * it uploads and what it prints.
 */
async function runLoop(options: {
  answer: Answer;
  include?: string[];
  shard?: string;
  projects?: boolean;
  testNamePattern?: string;
  passWithNoTests?: boolean;
}) {
  const sink = new InMemorySpanSink();
  const verdicts: SessionVerdict[] = [];
  const apiClient = {
    fetchQuarantine: vi.fn().mockResolvedValue(null),
    fetchFlakyContext: vi.fn().mockResolvedValue(null),
    fetchTestSelection: vi.fn().mockResolvedValue({ tests: [], ...options.answer }),
    uploadTrace: vi.fn().mockResolvedValue(undefined),
    sendSessionVerdict: vi.fn(async (verdict: SessionVerdict) => {
      verdicts.push(verdict);
      return { truncated: false };
    }),
  };
  const reporter = new MergifyReporter({ sink, apiClient });

  let output = '';
  const capture = new Writable({
    write(chunk, _encoding, done) {
      output += String(chunk);
      done();
    },
  });

  const include = options.include ?? ['selection.test.ts'];
  const vitest = await startVitest(
    'test',
    [],
    {
      root: fixturesDir,
      reporters: [reporter],
      watch: false,
      ...(options.projects ? { projects: [{ test: { name: 'unit', include } }] } : { include }),
      ...(options.shard ? { shard: options.shard } : {}),
      ...(options.testNamePattern ? { testNamePattern: options.testNamePattern } : {}),
      ...(options.passWithNoTests ? { passWithNoTests: true } : {}),
    },
    {},
    { stdout: capture, stderr: capture }
  );
  await vitest?.close();

  const executed = existsSync(markerFile)
    ? readFileSync(markerFile, 'utf8').split('\n').filter(Boolean).sort()
    : [];
  const requested = apiClient.fetchTestSelection.mock.calls[0]?.[4] as string | undefined;
  const resource = sink.getFinishedSpans()[0]?.resourceAttributes ?? {};
  return { reporter, apiClient, verdicts, executed, requested, resource, output };
}

describe('the reduced-rerun loop', () => {
  beforeEach(() => {
    markerDir = mkdtempSync(join(tmpdir(), 'mergify-selection-'));
    markerFile = join(markerDir, 'executed.txt');
    vi.stubEnv('MERGIFY_SELECTION_MARKER', markerFile);
    // See 'the opt-in gate' for why the event name comes first.
    vi.stubEnv('GITHUB_EVENT_NAME', 'push');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
    vi.stubEnv('GITHUB_HEAD_REF', '');
    vi.stubEnv('GITHUB_REF_NAME', 'queue/main/42');
    vi.stubEnv('GITHUB_SHA', 'cafecafe');
    vi.stubEnv('GITHUB_WORKFLOW', 'CI');
    vi.stubEnv('GITHUB_JOB', 'unit');
    vi.stubEnv(TEST_SELECTION_ENABLE_ENV, 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(markerDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const full: Answer = { selection: 'full', reason: 'no_predecessor' };
  const both = ['selection.test.ts', 'selection-other.test.ts'];

  it('gives each shard its own fingerprint, stable across attempts', async () => {
    // Every shard of a job reports under one job name; the fingerprint is
    // what lets the engine answer each from its own predecessor rather than
    // serve all of them the failures of all of them.
    const first = await runLoop({ answer: full, include: both, shard: '1/2' });
    rmSync(markerFile, { force: true });
    const second = await runLoop({ answer: full, include: both, shard: '2/2' });
    rmSync(markerFile, { force: true });
    const again = await runLoop({ answer: full, include: both, shard: '1/2' });
    rmSync(markerFile, { force: true });
    const whole = await runLoop({ answer: full, include: both });

    // The two shards really ran different files.
    expect([...first.executed, ...second.executed].sort()).toEqual([
      'alpha',
      'beta',
      'delta',
      'gamma',
    ]);
    expect(first.requested).toMatch(/^[0-9a-f]{64}$/);
    expect(first.requested).not.toBe(second.requested);
    expect(first.requested).toBe(again.requested);
    expect(whole.requested).not.toBe(first.requested);
    expect(whole.requested).not.toBe(second.requested);
  });

  it('tells apart shards that hold no file at all', async () => {
    // One file over three shards: two legs run nothing. Sharing the digest of
    // nothing, they would be one session twice to the engine, which refuses
    // to choose and fails both.
    // One run at a time: they share the marker file and the exit code.
    const first = await runLoop({ answer: full, shard: '1/3', passWithNoTests: true });
    const second = await runLoop({ answer: full, shard: '2/3', passWithNoTests: true });
    const third = await runLoop({ answer: full, shard: '3/3', passWithNoTests: true });
    expect(new Set([first.requested, second.requested, third.requested]).size).toBe(3);
  });

  it('puts a different name filter under a different fingerprint', async () => {
    // Same files, different tests: two legs of a matrix split by `-t` must not
    // be answered from each other's failures.
    const all = await runLoop({ answer: full });
    rmSync(markerFile, { force: true });
    const filtered = await runLoop({ answer: full, testNamePattern: 'gamma' });

    expect(filtered.executed).toEqual(['gamma']);
    expect(filtered.requested).toMatch(/^[0-9a-f]{64}$/);
    expect(filtered.requested).not.toBe(all.requested);
  });

  it('writes the verdict under the fingerprint it asked with', async () => {
    vi.stubEnv('MERGIFY_SELECTION_FAIL_BETA', '1');
    const { verdicts, requested, resource, reporter } = await runLoop({ answer: full });

    expect(reporter.getSession()!.status).toBe('failed');
    expect(verdicts).toHaveLength(1);
    const [verdict] = verdicts;
    expect(verdict).toMatchObject({
      headSha: 'cafecafe',
      pipelineName: 'CI',
      jobName: 'unit',
      collectionFingerprint: requested,
      collectionCount: 3,
      executedCount: 3,
      passedCount: 2,
      failedCount: 1,
      skippedCount: 0,
      failingTests: ['selection > beta'],
      quarantinedFailingTests: [],
      selection: { answer: 'full', reason: 'no_predecessor', keptCount: 3 },
    });
    // The same facts on the trace, where the engine reads them when no
    // verdict arrived.
    expect(resource).toMatchObject({
      'test.collection.fingerprint': requested,
      'test.collection.count': 3,
      'test.selection.answer': 'full',
      'test.selection.kept_count': 3,
    });
  });

  it('replays only the served subset, and says so', async () => {
    const { executed, verdicts, output } = await runLoop({
      answer: { selection: 'subset', reason: 'reduced_rerun', tests: ['selection > beta'] },
    });

    expect(executed).toEqual(['beta']);
    expect(verdicts[0]).toMatchObject({
      collectionCount: 3,
      executedCount: 1,
      passedCount: 1,
      failingTests: [],
      selection: { answer: 'subset', keptCount: 1 },
    });
    expect(output).toContain('Mergify re-executed only');
    expect(process.exitCode).toBeUndefined();
  });

  it('runs nothing on `empty`, and ends green', async () => {
    const { executed, verdicts, output, reporter } = await runLoop({
      answer: { selection: 'empty', reason: 'predecessor_passed' },
    });

    expect(executed).toEqual([]);
    expect(reporter.getSession()!.status).toBe('passed');
    expect(process.exitCode).toBeUndefined();
    expect(verdicts[0]).toMatchObject({
      collectionCount: 3,
      executedCount: 0,
      failedCount: 0,
      selection: { answer: 'empty', keptCount: 0 },
    });
    expect(output).toContain('all 3 tests passed back then');
  });

  it('keeps a shard served `empty` green', async () => {
    // The shard whose slice passed on the previous attempt: it runs nothing,
    // and must not fail the batch for it.
    const { executed, reporter } = await runLoop({
      answer: { selection: 'empty', reason: 'predecessor_passed' },
      include: both,
      shard: '2/2',
    });

    expect(executed).toEqual([]);
    expect(reporter.getSession()!.status).toBe('passed');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails a refused run without running anything', async () => {
    const { executed, output, reporter } = await runLoop({
      answer: {
        selection: 'refused',
        reason: 'indeterminate',
        message: 'Several runs share this job name.',
      },
    });

    expect(executed).toEqual([]);
    expect(output).toContain('Several runs share this job name.');
    expect(reporter.getSession()!.status).toBe('failed');
    expect(process.exitCode).toBe(1);
  });

  it('asks nothing under `test.projects`, where no project loads the runner', async () => {
    const { apiClient, executed, verdicts } = await runLoop({ answer: full, projects: true });

    expect(apiClient.fetchTestSelection).not.toHaveBeenCalled();
    expect(verdicts).toEqual([]);
    expect(executed).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('asks nothing in browser mode, where the runner never loads', () => {
    const root = { config: { browser: { enabled: true } } };
    const vitest = { config: {}, getRootProject: () => root } as unknown as Vitest;
    const specifications = [{ project: root }] as unknown as TestSpecification[];

    expect(selectionUnreachable(vitest, specifications)).toMatch(/browser mode/);
    root.config.browser.enabled = false;
    expect(selectionUnreachable(vitest, specifications)).toBeUndefined();
  });
});

describe('what the verdict must not claim', () => {
  beforeEach(() => {
    markerDir = mkdtempSync(join(tmpdir(), 'mergify-selection-'));
    markerFile = join(markerDir, 'executed.txt');
    vi.stubEnv('MERGIFY_SELECTION_MARKER', markerFile);
    vi.stubEnv('GITHUB_EVENT_NAME', 'push');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
    vi.stubEnv('GITHUB_HEAD_REF', '');
    vi.stubEnv('GITHUB_REF_NAME', 'queue/main/42');
    vi.stubEnv('GITHUB_SHA', 'cafecafe');
    vi.stubEnv('GITHUB_WORKFLOW', 'CI');
    vi.stubEnv('GITHUB_JOB', 'unit');
    vi.stubEnv(TEST_SELECTION_ENABLE_ENV, 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(markerDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const full: Answer = { selection: 'full', reason: 'no_predecessor' };
  const other = ['selection-other.test.ts'];

  it('sends no verdict when a hook failed, whose tests read as skipped', async () => {
    // Sent, it would name no failure: the retry would be served `empty`, run
    // nothing, and turn green on the same broken hook.
    vi.stubEnv('MERGIFY_SELECTION_BREAK_HOOK', '1');
    const { verdicts, output, reporter } = await runLoop({ answer: full, include: other });

    expect(reporter.getSession()!.status).toBe('failed');
    expect(verdicts).toEqual([]);
    expect(output).toContain("Mergify wasn't sent this run's results");
  });

  it('sends no verdict when an error escaped every test', async () => {
    vi.stubEnv('MERGIFY_SELECTION_LEAK_REJECTION', '1');
    const { verdicts } = await runLoop({ answer: full, include: other });

    expect(verdicts).toEqual([]);
  });

  it('counts no test as executed on `empty`, not even one the author skipped', async () => {
    // A skipped test counts as executed, and an `empty` run that reports one
    // stops reading as "ran nothing" -- the answer after which Mergify runs
    // the full suite again rather than chain `empty` forever.
    const { verdicts, executed } = await runLoop({
      answer: { selection: 'empty', reason: 'predecessor_passed' },
      include: other,
    });

    expect(executed).toEqual([]);
    expect(verdicts[0]).toMatchObject({ collectionCount: 2, executedCount: 0 });
  });

  it('fails a subset only part of which is collected here', async () => {
    // Running the part that matched would go green without the missing one,
    // and the verdict would then tell the next attempt nothing failed.
    const { executed, reporter } = await runLoop({
      answer: {
        selection: 'subset',
        reason: 'reduced_rerun',
        tests: ['selection > beta', 'selection > renamed-since'],
      },
    });

    expect(executed).toEqual(['beta']);
    expect(reporter.getSession()!.status).toBe('failed');
    expect(process.exitCode).toBe(1);
  });
});
