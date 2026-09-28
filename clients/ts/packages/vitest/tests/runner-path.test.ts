import { existsSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Vitest } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';

/**
 * The reporter points `config.runner` at a file it computes itself, and nothing
 * downstream checks that the file is there — vitest simply fails to load it and
 * the run dies having executed nothing. That is how `runner.js` reached 0.3.4,
 * a name matching no emitted file, while every runner test passed: they all
 * import the runner module directly, so none of them ever exercised the path
 * computation.
 *
 * These tests exist for the computation alone (#87).
 */
function fakeVitest(overrides: { runner?: string; version?: string } = {}): Vitest {
  const logs: string[] = [];
  return {
    version: overrides.version ?? '4.1.10',
    config: { runner: overrides.runner },
    logger: { log: (msg: string) => logs.push(msg) },
    provide: () => {},
    projects: [],
  } as unknown as Vitest;
}

function configuredRunner(options: { runner?: string; version?: string } = {}): string | undefined {
  const vitest = fakeVitest(options);
  // A quarantine list is the cheapest way in: it is the one seam that reaches
  // `_configureRunner` synchronously, and one name is enough to trigger it.
  new MergifyReporter({ quarantineList: ['suite > quarantined'] }).onInit(vitest);
  return vitest.config.runner;
}

describe('the runner path', () => {
  it('points at a file that actually exists', () => {
    const runner = configuredRunner();

    // The assertion the four broken releases needed. It holds in every mode
    // because the extension is derived rather than assumed: `runner.ts` here,
    // `runner.mjs` beside the ESM build, `runner.cjs` beside the CJS one.
    expect(runner).toBeDefined();
    expect(existsSync(runner!)).toBe(true);
  });

  it('is the sibling of the reporter module, carrying the same extension', () => {
    const runner = configuredRunner()!;
    const self = fileURLToPath(import.meta.url);

    // Pins the invariant rather than the current filename: whatever tsdown
    // emits next, the runner is `runner` + this build's own extension, next to
    // the module doing the resolving. `runner.js` is what a hardcoded name
    // produced, and it belongs to no build.
    expect(basename(runner)).toBe(`runner${extname(self)}`);
    expect(basename(runner)).not.toBe('runner.js');
    expect(dirname(runner)).toBe(
      dirname(fileURLToPath(new URL('../src/reporter.ts', import.meta.url)))
    );
  });

  // The runner base class lives in `vitest` from 4.1 and in `vitest/runners`
  // before; 5.0 removed the latter. Each generation gets the entry built on the
  // base it actually has, and both must exist.
  it.each([
    ['3.0.9', 'runner-legacy'],
    ['3.2.4', 'runner-legacy'],
    ['4.0.18', 'runner-legacy'],
    ['4.1.0', 'runner'],
    ['4.1.11', 'runner'],
    ['5.0.1', 'runner'],
  ])('on Vitest %s, points at the %s entry', (version, entry) => {
    const runner = configuredRunner({ version })!;
    const self = fileURLToPath(import.meta.url);

    expect(basename(runner)).toBe(`${entry}${extname(self)}`);
    expect(existsSync(runner)).toBe(true);
  });

  it('leaves a runner the user configured themselves alone', () => {
    const theirs = '/somewhere/their-own-runner.ts';
    expect(configuredRunner({ runner: theirs })).toBe(theirs);
  });
});
