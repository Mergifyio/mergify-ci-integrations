import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The slice a sharded leg fingerprints has to be the one Playwright will
// actually run -- a leg that asks about a different set gets an answer keyed on
// nothing, and the reduction never happens. Only the real runner can prove it:
// the slice depends on hooks, `describe` modes and per-project `fullyParallel`
// that a stub suite cannot carry.
//
// `tests/fixtures/sharding-probe.ts` reads both slices off ONE run -- what
// `playwrightSlice` obtained by asking Playwright, and the suite Playwright had
// already sharded by `onBegin` -- so the two come from the same collection.

const playwrightBin = resolve(
  import.meta.dirname,
  '..',
  '..',
  'node_modules',
  '.bin',
  'playwright'
);
const config = resolve(import.meta.dirname, '..', 'fixtures', 'sharding.config.ts');

interface Slices {
  asked: string[];
  corpus: string[];
  playwright: string[];
}

function slicesOf(
  shard: string,
  extra: string[] = [],
  env: Record<string, string> = {},
  options: { config?: string; cwd?: string } = {}
): Slices {
  const run = spawnSync(
    playwrightBin,
    ['test', '-c', options.config ?? config, '--shard', shard, '--list', ...extra],
    { encoding: 'utf8', env: { ...process.env, ...env }, cwd: options.cwd }
  );
  const line = run.stdout.split('\n').find((l) => l.startsWith('SHARDING'));
  if (!line) {
    throw new Error(`No slice reported for shard ${shard}:\n${run.stdout}\n${run.stderr}`);
  }
  return JSON.parse(line.slice('SHARDING'.length)) as Slices;
}

const fixture = (name: string) => resolve(import.meta.dirname, '..', 'fixtures', name);

describe('the slice a sharded leg asks Playwright for', () => {
  // The fixture mixes every case Playwright's own grouping tells apart: plain
  // parallel tests, a file with a `beforeAll` outside any sequential suite, a
  // `describe.serial`, a `describe.configure({ mode: 'default' })`, and a
  // second project that is not `fullyParallel` at all.
  for (const total of [3, 4, 7]) {
    it(`is the one Playwright runs, test for test, over ${total} legs`, () => {
      const seen: string[] = [];
      for (let current = 1; current <= total; current++) {
        const { asked, playwright } = slicesOf(`${current}/${total}`);
        expect(asked).toEqual(playwright);
        expect(asked.length).toBeGreaterThan(0);
        seen.push(...asked);
      }
      // And the legs together are the whole suite, each test once: a slice that
      // matched leg by leg while dropping a test would still be wrong.
      expect(seen.length).toBe(new Set(seen).size);
      expect([...seen].sort()).toEqual(slicesOf('1/1').playwright);
    }, 120_000);
  }

  it("follows the run's own weights, because Playwright applies them itself", () => {
    // Nothing in the reporter reads PWTEST_SHARD_WEIGHTS any more: the listing
    // run inherits the variable and Playwright weights the legs for us.
    const env = { PWTEST_SHARD_WEIGHTS: '3:1' };
    const heavy = slicesOf('1/2', [], env);
    const light = slicesOf('2/2', [], env);

    expect(heavy.asked).toEqual(heavy.playwright);
    expect(light.asked).toEqual(light.playwright);
    expect(heavy.asked.length).toBeGreaterThan(light.asked.length);
  }, 60_000);

  it("replays the run's filters, so a --grep does not draw the slice over another corpus", () => {
    // The guard that matters most: the listing must see the same corpus. A
    // filter left behind would shard a larger suite, hand back a slice of tests
    // this run will not execute, and the fingerprint would match nothing.
    const filtered = slicesOf('1/2', ['--grep', 'serial']);

    expect(filtered.asked).toEqual(filtered.playwright);
    expect(filtered.playwright.length).toBeLessThan(slicesOf('1/2').playwright.length);
    expect(filtered.asked.length).toBeGreaterThan(0);
  }, 60_000);

  it('is the same slice on a second run of the same tree, which is what makes a rerun match', () => {
    const first = slicesOf('2/4');
    const second = slicesOf('2/4');

    // Asserting the two runs agree is not enough on its own: two failed
    // listings agree on nothing, so pin the slice to Playwright's as well.
    expect(second.asked).toEqual(first.asked);
    expect(first.asked).toEqual(first.playwright);
    expect(first.asked.length).toBeGreaterThan(0);
  }, 60_000);

  // Three projects over one file, run from the config's own directory so
  // `rootDir === cwd`. Playwright's JSON reporter merges specs across projects
  // under exactly that condition and reports one id for all three copies; a
  // listing built on those ids returned seven for a leg of fourteen, agreed
  // with itself, and excluded the other seven from every leg -- a green job
  // that ran half its tests.
  it('gives a multi-project leg every one of its tests, ids not collapsed', () => {
    const dir = fixture('sharding-merged');
    const legs = [1, 2].map((current) =>
      slicesOf(`${current}/2`, [], {}, { config: resolve(dir, 'playwright.config.ts'), cwd: dir })
    );

    for (const leg of legs) {
      expect(leg.asked).toEqual(leg.playwright);
    }
    // 7 tests x 3 projects, and the legs must not be the same size, or the
    // collapse would be invisible.
    expect(legs[0].asked.length + legs[1].asked.length).toBe(21);
    expect(new Set([...legs[0].asked, ...legs[1].asked]).size).toBe(21);
  }, 120_000);

  // Playwright re-attaches a setup project to every leg after sharding, while
  // the reporter may not touch its tests at all. Both sides drop it through the
  // same helper, so the leg still gets a selection instead of silently running
  // unreduced on the commonest sharded layout there is.
  it('still reduces a leg whose config has a setup project', () => {
    const dir = fixture('sharding-setup');
    const legs = [1, 2].map((current) =>
      slicesOf(`${current}/2`, [], {}, { config: resolve(dir, 'playwright.config.ts'), cwd: dir })
    );

    for (const leg of legs) {
      expect(leg.asked).toEqual(leg.playwright);
      expect(leg.asked.length).toBeGreaterThan(0);
      // The corpus is the six selectable tests; the setup test is in neither.
      expect(leg.corpus).toHaveLength(6);
    }
    expect(legs[0].asked.length + legs[1].asked.length).toBe(6);
  }, 120_000);
});
