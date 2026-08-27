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
function fakeVitest(overrides: { runner?: string } = {}): Vitest {
  const logs: string[] = [];
  return {
    version: '4.1.10',
    config: { runner: overrides.runner },
    logger: { log: (msg: string) => logs.push(msg) },
    provide: () => {},
  } as unknown as Vitest;
}

function configuredRunner(options: { runner?: string } = {}): string | undefined {
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

  it('leaves a runner the user configured themselves alone', () => {
    const theirs = '/somewhere/their-own-runner.ts';
    expect(configuredRunner({ runner: theirs })).toBe(theirs);
  });
});
