import * as vitestModule from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Vitest 4.1 moved the runner base class to `vitest` (`TestRunner`) and
 * deprecated `vitest/runners`; Vitest 5 removed that subpath. A runner still
 * importing it prints a deprecation warning in every 4.1 run, hangs the
 * Cloudflare Workers pool — the warning is console output at module scope,
 * which workerd refuses — and fails every 5.0 run outright, the moment the
 * reporter installs it (a first quarantined test is enough).
 */
describe('the runner Vitest 4.1 and later load', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extends the TestRunner Vitest exports, without touching the deprecated subpath', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();

    const { default: MergifyRunner } = await import('../src/runner.js');

    expect(MergifyRunner.prototype).toBeInstanceOf(vitestModule.TestRunner);
    const deprecations = warn.mock.calls.filter((call) =>
      String(call[0]).includes('vitest/runners')
    );
    expect(deprecations).toEqual([]);
  });
});
