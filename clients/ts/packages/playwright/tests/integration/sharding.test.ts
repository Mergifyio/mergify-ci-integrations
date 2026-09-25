import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The partition has to be Playwright's own, test for test -- a leg that runs a
// different slice than Playwright would runs a differently-sized share of the
// suite, and the wall of a sharded job is its slowest leg. Only the real runner
// can prove it: the grouping reads what Playwright built in memory, and the
// answer depends on hooks and `describe` modes a stub suite cannot carry.
//
// `tests/fixtures/sharding-probe.ts` captures both partitions of ONE run -- the
// plugin's from `preprocess`, Playwright's from the suite it has already
// sharded by `onBegin` -- so the two are read off the same collection.

const playwrightBin = resolve(
  import.meta.dirname,
  '..',
  '..',
  'node_modules',
  '.bin',
  'playwright'
);
const config = resolve(import.meta.dirname, '..', 'fixtures', 'sharding.config.ts');

interface Partitions {
  plugin: string[];
  playwright: string[];
}

function partitionsOf(shard: string, env: Record<string, string> = {}): Partitions {
  const run = spawnSync(playwrightBin, ['test', '-c', config, '--shard', shard, '--list'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const line = run.stdout.split('\n').find((l) => l.startsWith('SHARDING'));
  if (!line) {
    throw new Error(`No partition reported for shard ${shard}:\n${run.stdout}\n${run.stderr}`);
  }
  return JSON.parse(line.slice('SHARDING'.length)) as Partitions;
}

describe('the partition a sharded leg computes', () => {
  // The fixture mixes every case `createTestGroups` tells apart: plain
  // parallel tests, a file with a `beforeAll` outside any sequential suite, a
  // `describe.serial`, a `describe.configure({ mode: 'default' })`, and a
  // second project that is not `fullyParallel` at all.
  for (const total of [3, 4, 7]) {
    it(`is Playwright's own, test for test, over ${total} legs`, () => {
      const seen: string[] = [];
      for (let current = 1; current <= total; current++) {
        const { plugin, playwright } = partitionsOf(`${current}/${total}`);
        expect(plugin).toEqual(playwright);
        expect(plugin.length).toBeGreaterThan(0);
        seen.push(...plugin);
      }
      // And the legs together are the whole suite, each test once: a partition
      // that matched leg by leg while dropping a test would still be wrong.
      expect(seen.length).toBe(new Set(seen).size);
      const whole = partitionsOf('1/1');
      expect([...seen].sort()).toEqual(whole.playwright);
    });
  }

  it("follows Playwright's weights when the legs are weighted", () => {
    const env = { PWTEST_SHARD_WEIGHTS: '3:1' };
    const heavy = partitionsOf('1/2', env);
    const light = partitionsOf('2/2', env);
    expect(heavy.plugin).toEqual(heavy.playwright);
    expect(light.plugin).toEqual(light.playwright);
    expect(heavy.plugin.length).toBeGreaterThan(light.plugin.length);
  });

  it('is the same slice on a second run of the same tree, which is what makes a rerun match', () => {
    const first = partitionsOf('2/4');
    const second = partitionsOf('2/4');
    expect(second.plugin).toEqual(first.plugin);
  });
});
