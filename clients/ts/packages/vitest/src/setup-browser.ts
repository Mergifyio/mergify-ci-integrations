import { TestRunner } from 'vitest';
import { extendRunner } from './extend-runner.js';

/**
 * The setup file the reporter injects into browser projects on Vitest 4.1 and
 * later. It runs in the page, which cannot load ci-core's native binding, so
 * it carries quarantine and test selection but no flaky detection — whose
 * rerun budget needs that binding. The reporter says so at the end of the run.
 */
extendRunner(TestRunner, null);
