import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
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
}): Promise<{ reporter: MergifyReporter; exporter: InMemorySpanExporter; executed: string[] }> {
  const exporter = new InMemorySpanExporter();
  const reporter = new MergifyReporter({ exporter, testSelection: options.testSelection });

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
  return { reporter, exporter, executed };
}

function uploadedNames(exporter: InMemorySpanExporter): string[] {
  return exporter
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
    const { reporter, exporter } = await runSelection({ testSelection: ['selection > beta'] });

    // A test that never ran has no result to report — not even a skipped one.
    expect(uploadedNames(exporter)).toEqual(['selection > beta']);
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
    expect(reporter.getSelection().selection?.selection).toBe('full');
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
    const uploaded = uploadedNames(first.exporter);

    rmSync(markerFile, { force: true });
    const second = await runSelection({ testSelection: [uploaded[1]] });

    expect(uploaded).toEqual(['selection > alpha', 'selection > beta', 'selection > gamma']);
    expect(second.executed).toEqual(['beta']);
  });
});
