import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A Playwright output directory of this run's own. The integration files run
 * Playwright concurrently from this one fixtures directory, and each run
 * empties its output directory on start and writes `.last-run.json` there at
 * the end: shared, one run deleted it under another, which then failed.
 *
 * Made once, in the runner process, and handed down through the environment:
 * workers and the subprocesses the reporter spawns load this config again and
 * must land on the same directory.
 */
export function runOutputDir(): string {
  process.env.PW_FIXTURE_OUTPUT_DIR ??= mkdtempSync(join(tmpdir(), 'mergify-pw-fixture-'));
  return process.env.PW_FIXTURE_OUTPUT_DIR;
}
