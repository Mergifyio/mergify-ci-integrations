import { VitestTestRunner } from 'vitest/runners';
import { createMergifyRunner } from './mergify-runner.js';

/**
 * The runner the reporter installs on Vitest before 4.1, which exports the
 * runner base class only from `vitest/runners`. Nothing imports this module on
 * 4.1 and later: see `runner.ts`.
 */
export default createMergifyRunner(VitestTestRunner);
