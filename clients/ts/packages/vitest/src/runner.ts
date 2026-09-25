import { TestRunner } from 'vitest';
import { createMergifyRunner } from './mergify-runner.js';

/**
 * The runner the reporter installs on Vitest 4.1 and later, built on the
 * `TestRunner` those versions export from `vitest`. Importing `vitest/runners`
 * instead prints a deprecation warning on 4.1 — console output at module scope,
 * which hangs the Cloudflare Workers pool — and fails on 5.0, which removed it.
 */
export default createMergifyRunner(TestRunner);
