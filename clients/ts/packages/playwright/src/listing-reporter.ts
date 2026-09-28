import type { Reporter, Suite, TestCase } from '@playwright/test/reporter';
import { projectNameFromTest, readonlyProjectNames } from './utils.js';

/**
 * The reporter the listing subprocess runs, and nothing else.
 *
 * `shard.ts` replays this run's own command line with `--list` and this
 * reporter, to learn which tests Playwright gives this leg. It prints two sets:
 *
 * - **the corpus**, from `preprocess`, before Playwright shards — which the
 *   parent compares, as a set, against what it collected itself. They must be
 *   equal: if the listing saw a different suite (a filter the replay dropped, a
 *   `test.only` that `--list` does not apply, a tree that moved under us) the
 *   parent has no business trusting its slice, and runs the leg in full.
 * - **the slice**, from `onBegin`, which Playwright has by then sharded.
 *
 * Both are `TestCase.id` values, the identity Playwright itself assigns, read
 * straight off the suite. An earlier version read the JSON reporter's
 * `spec.id`, which is NOT that: `--reporter=json` merges specs across projects
 * that share a file, keeping only the first project's id, so a three-project
 * leg of fourteen tests reported seven ids. The parent's counts agreed with
 * each other, the guard passed, and seven tests ran on no leg at all -- a green
 * job that skipped them. Reading the suite cannot drift like that, because it
 * is the very object the run executes.
 *
 * Setup and teardown projects are dropped on both sides through the same
 * helper: Playwright re-attaches their suites to every leg after sharding, so a
 * listing that kept them would never match a collection that cannot hold them,
 * and a sharded run with an auth-setup project -- the common shape -- would
 * lose its reduction for a mismatch that is not one.
 */

/** The line the parent reads, distinctive enough to find among a runner's own output. */
export const LISTING_MARKER = '@mergifyio/playwright:listing:';

export interface Listing {
  corpus: string[];
  slice: string[];
}

function selectableIds(suite: Suite): string[] {
  const readonly = readonlyProjectNames(suite);
  return suite
    .allTests()
    .filter((test: TestCase) => !readonly.has(projectNameFromTest(test) ?? ''))
    .map((test: TestCase) => test.id);
}

export default class ListingReporter implements Reporter {
  private corpus: string[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: the 1.62+ hook, typed as the
  // main reporter types it so this file builds against an older Playwright.
  async preprocess(params: any): Promise<void> {
    this.corpus = selectableIds(params.suite);
  }

  onBegin(_config: unknown, suite: Suite): void {
    const listing: Listing = { corpus: this.corpus, slice: selectableIds(suite) };
    process.stdout.write(`${LISTING_MARKER}${JSON.stringify(listing)}\n`);
  }

  printsToStdio(): boolean {
    // The marker is the only thing this run exists to emit; saying so keeps
    // Playwright from adding its own `list` reporter beside it.
    return true;
  }
}
