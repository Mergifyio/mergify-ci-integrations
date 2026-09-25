import { existsSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Vitest } from 'vitest/node';
import { MergifyReporter } from '../src/reporter.js';

/**
 * The reporter points each project at a setup file it computes itself, and
 * nothing downstream checks that the file is there — vitest simply fails to
 * load it and the run dies having executed nothing. That is how `runner.js`
 * reached 0.3.4, a name matching no emitted file, while every test passed:
 * they all imported the module directly, so none of them ever exercised the
 * path computation (#87).
 *
 * These tests exist for the computation alone.
 */
interface FakeProject {
  name: string;
  config: { browser: { enabled: boolean }; setupFiles: string[]; runner?: string };
  provide: () => void;
}

function fakeVitest(options: { version?: string; runner?: string; browser?: boolean } = {}) {
  const projects: FakeProject[] = [
    {
      name: 'node',
      config: { browser: { enabled: false }, setupFiles: [], runner: options.runner },
      provide: () => {},
    },
    { name: 'web', config: { browser: { enabled: true }, setupFiles: [] }, provide: () => {} },
  ];
  const vitest = {
    version: options.version ?? '4.1.10',
    config: { runner: options.runner },
    logger: { log: () => {} },
    provide: () => {},
    projects,
  } as unknown as Vitest;
  // A quarantine list is the cheapest way in: it is the one seam that installs
  // the setup file synchronously, and one name is enough to trigger it.
  new MergifyReporter({ quarantineList: ['suite > quarantined'] }).onInit(vitest);
  return { vitest, projects };
}

const self = fileURLToPath(import.meta.url);
const sourceDir = dirname(fileURLToPath(new URL('../src/reporter.ts', import.meta.url)));

describe('the setup file path', () => {
  it('points at files that actually exist, siblings of the reporter carrying its extension', () => {
    const { projects } = fakeVitest();

    for (const project of projects) {
      expect(project.config.setupFiles).toHaveLength(1);
      const setup = project.config.setupFiles[0];
      // Pins the invariant rather than a filename: whatever tsdown emits next,
      // the setup file is next to the module doing the resolving, with this
      // build's own extension. `.js` is what a hardcoded name produced, and it
      // belongs to no build.
      expect(existsSync(setup)).toBe(true);
      expect(extname(setup)).toBe(extname(self));
      expect(dirname(setup)).toBe(sourceDir);
    }
  });

  // The runner base class lives in `vitest` from 4.1 and in `vitest/runners`
  // before; 5.0 removed the latter. A page cannot load ci-core's native
  // binding. Each project gets the file built for where it runs and for the
  // Vitest running it.
  it.each([
    ['3.0.9', 'setup-legacy', 'setup-browser-legacy'],
    ['3.2.4', 'setup-legacy', 'setup-browser-legacy'],
    ['4.0.18', 'setup-legacy', 'setup-browser-legacy'],
    ['4.1.0', 'setup', 'setup-browser'],
    ['5.0.1', 'setup', 'setup-browser'],
  ])('on Vitest %s, gives a Node project %s and a browser one %s', (version, node, web) => {
    const { projects } = fakeVitest({ version });

    expect(basename(projects[0].config.setupFiles[0])).toBe(`${node}${extname(self)}`);
    expect(basename(projects[1].config.setupFiles[0])).toBe(`${web}${extname(self)}`);
  });

  it('is added once however many features ask for it', () => {
    const { vitest, projects } = fakeVitest();
    new MergifyReporter({ quarantineList: ['suite > other'] }).onInit(vitest);

    expect(projects[0].config.setupFiles).toHaveLength(1);
  });

  it('leaves a runner the user configured themselves alone', () => {
    const theirs = '/somewhere/their-own-runner.ts';
    const { vitest, projects } = fakeVitest({ runner: theirs });

    expect(vitest.config.runner).toBe(theirs);
    expect(projects[0].config.runner).toBe(theirs);
  });
});
