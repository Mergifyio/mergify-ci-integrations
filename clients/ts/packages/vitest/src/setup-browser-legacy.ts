import { VitestTestRunner } from 'vitest/runners';
import { extendRunner } from './extend-runner.js';

/**
 * `setup-browser.ts` for Vitest before 4.1, which export the runner base class
 * only from `vitest/runners`.
 */
extendRunner(VitestTestRunner, null);
