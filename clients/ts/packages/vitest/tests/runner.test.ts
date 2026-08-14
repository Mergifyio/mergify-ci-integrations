import { resolve } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVitest } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';

const fixturesDir = resolve(import.meta.dirname, 'fixtures');

async function runFixture(file: string, quarantineList: string[]) {
  const exporter = new InMemorySpanExporter();
  const reporter = new MergifyReporter({ exporter, quarantineList });

  const vitest = await startVitest('test', [], {
    root: fixturesDir,
    include: [file],
    reporters: [reporter],
    watch: false,
  });
  await vitest?.close();

  const caseSpans = exporter
    .getFinishedSpans()
    .filter((s) => s.attributes['test.scope'] === 'case');

  return {
    status: reporter.getSession()!.status,
    uploadedNames: caseSpans.map((s) => s.name),
    quarantinedNames: caseSpans
      .filter((s) => s.attributes['cicd.test.quarantined'] === true)
      .map((s) => s.name),
  };
}

describe('Quarantine runner', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('quarantined failing test does not fail the run', async () => {
    const run = await runFixture('failing.test.ts', ['math > fails intentionally']);

    // The session should report as passed because the failure was quarantined
    expect(run.status).toBe('passed');
  });

  it('sets cicd.test.quarantined span attribute on quarantined tests', async () => {
    const run = await runFixture('failing.test.ts', ['math > fails intentionally']);

    expect(run.quarantinedNames).toEqual(['math > fails intentionally']);
  });

  it('non-quarantined failing test still fails the run', async () => {
    const run = await runFixture('failing.test.ts', ['some > other test']);

    expect(run.status).toBe('failed');
  });

  it('mixed: quarantined failure + passing test = passing run', async () => {
    const run = await runFixture('mixed.test.ts', ['outer > inner > fails']);

    // The only failure is quarantined, so the run should pass
    expect(run.status).toBe('passed');
    expect(run.quarantinedNames).toEqual(['outer > inner > fails']);
  });

  it('ignores the file path, which the uploaded name never carries', async () => {
    const run = await runFixture('failing.test.ts', [
      'failing.test.ts > math > fails intentionally',
    ]);

    expect(run.status).toBe('failed');
    expect(run.quarantinedNames).toEqual([]);
  });

  // The names the runner matches on and the names the reporter uploads have to
  // be the same string: quarantine and flaky detection are both keyed on what
  // the server stored, and the server only ever stores what was uploaded.
  // Feeding a first run's own exported span names back in is what keeps this
  // honest — it cannot pass on a name shape production never produces.
  it.for([
    { fixture: 'mixed.test.ts', failing: 'outer > inner > fails' },
    // A test outside any suite uploads a bare name, with no namespace to
    // prefix it — the one case where the two constructions handle an empty
    // suite chain rather than joining one.
    { fixture: 'root-level.test.ts', failing: 'fails outside any suite' },
  ])('quarantines on the exact names the reporter uploads ($fixture)', async ({
    fixture,
    failing,
  }) => {
    const first = await runFixture(fixture, []);
    expect(first.uploadedNames).toContain(failing);

    const second = await runFixture(fixture, first.uploadedNames);

    expect(second.status).toBe('passed');
    expect(second.quarantinedNames).toEqual([failing]);
  });
});
