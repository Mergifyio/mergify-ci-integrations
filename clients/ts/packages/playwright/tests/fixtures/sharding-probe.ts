// Captures both slices of one run: the one the reporter obtains by asking
// Playwright (`listPlaywrightSlice`, the shipped function), and Playwright's
// own, read in `onBegin` from the suite it has already sharded. Reading both
// off a single run is what makes them comparable test for test.
//
// Playwright's side goes through the same readonly-project helper the reporter
// uses, because a setup or teardown project is re-attached to every leg after
// sharding and is deliberately outside the selection on both sides.
import type { Reporter, Suite, TestCase } from '@playwright/test/reporter';
import { listPlaywrightSlice } from '../../src/shard.js';
import { projectNameFromTest, readonlyProjectNames } from '../../src/utils.js';

export default class ShardingProbe implements Reporter {
  private asked: string[] = [];
  private corpus: string[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: the 1.62+ hook, typed here as
  // the reporter itself types it, so the fixture builds on an older Playwright.
  preprocess(params: any): void {
    if (!params.config.shard) return;
    const listing = listPlaywrightSlice((message) => process.stderr.write(`${message}\n`));
    this.asked = listing ? [...listing.slice].sort() : [];
    this.corpus = listing ? [...listing.corpus].sort() : [];
  }

  onBegin(_config: unknown, suite: Suite): void {
    const readonly = readonlyProjectNames(suite);
    const own = suite
      .allTests()
      .filter((test: TestCase) => !readonly.has(projectNameFromTest(test) ?? ''))
      .map((test: TestCase) => test.id)
      .sort();
    process.stdout.write(
      `SHARDING${JSON.stringify({ asked: this.asked, corpus: this.corpus, playwright: own })}\n`
    );
  }
}
