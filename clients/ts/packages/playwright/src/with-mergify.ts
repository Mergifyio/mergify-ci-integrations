import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaywrightTestConfig } from '@playwright/test';

type ReporterEntry = [string] | [string, unknown];

function reporterToArray(r: PlaywrightTestConfig['reporter']): ReporterEntry[] {
  if (r === undefined) return [];
  if (typeof r === 'string') return [[r]];
  if (Array.isArray(r)) {
    // Could be a single tuple ['list', {...}] OR an array of tuples.
    if (r.length > 0 && typeof r[0] === 'string') {
      return [r as unknown as ReporterEntry];
    }
    return r as unknown as ReporterEntry[];
  }
  return [];
}

function pathArray(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value as string];
}

/**
 * Wrap a Playwright config to inject the Mergify reporter, globalSetup, and
 * globalTeardown. Existing user entries are preserved — Mergify's are appended.
 */
export function withMergify(config: PlaywrightTestConfig): PlaywrightTestConfig {
  // Resolve sibling entry points relative to this module's own location, using
  // the matching extension. tsdown emits .mjs and .cjs — not plain .js — so a
  // hard-coded `global-setup.js` would point at a non-existent file. In
  // source/dev mode (e.g. running through tsx) `current` ends in .ts and we
  // fall back to .js, letting the loader pick the TS file it wants.
  const current = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const dir = dirname(current);
  const ext = current.endsWith('.cjs') ? '.cjs' : current.endsWith('.mjs') ? '.mjs' : '.js';

  // `reporter` is not a dedicated entry point — it's bundled into the package
  // index. Point Playwright at the index so it picks up MergifyReporter as the
  // default export.
  const reporterPath = resolve(dir, `index${ext}`);
  const setupPath = resolve(dir, `global-setup${ext}`);
  const teardownPath = resolve(dir, `global-teardown${ext}`);

  return {
    ...config,
    reporter: [...reporterToArray(config.reporter), [reporterPath]],
    globalSetup: [...pathArray(config.globalSetup), setupPath],
    globalTeardown: [...pathArray(config.globalTeardown), teardownPath],
  };
}
