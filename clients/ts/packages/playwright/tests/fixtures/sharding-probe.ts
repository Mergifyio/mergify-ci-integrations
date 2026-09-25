// Captures both partitions of one run: the plugin's, computed in `preprocess`
// exactly as the reporter computes it, and Playwright's own, read in `onBegin`
// from the suite it has already sharded. Printing both from a single run is
// what makes them comparable list for list.
import type { Reporter, Suite, TestCase } from '@playwright/test/reporter';
import { shardSlice, shardWeights, testGroups } from '../../src/reporter.js';

const identify = (test: TestCase): string => `${test.titlePath().filter(Boolean).join(' > ')}`;

export default class ShardingProbe implements Reporter {
  private plugin: string[] = [];

  // biome-ignore lint/suspicious/noExplicitAny: the 1.62+ hook, typed here as
  // the reporter itself types it, so the fixture builds on an older Playwright.
  preprocess(params: any): void {
    const shard = params.config.shard;
    if (!shard) return;
    const byProject = new Map<string, TestCase[]>();
    for (const test of params.suite.allTests() as TestCase[]) {
      const name = test.parent?.project?.()?.name ?? '';
      const inProject = byProject.get(name);
      if (inProject) inProject.push(test);
      else byProject.set(name, [test]);
    }
    const kept = shardSlice(
      testGroups(
        [...byProject.values()],
        (test) => test,
        (test) => test.parent?.project?.()?.name ?? '',
        shard.total
      ),
      shard,
      // The reporter reads the weights the same way; the probe has to, or it
      // would compare a weighted partition against an unweighted one.
      shardWeights(shard.total, (message) => process.stderr.write(`${message}\n`))
    );
    this.plugin = [...kept].map(identify).sort();
  }

  onBegin(_config: unknown, suite: Suite): void {
    const playwright = suite.allTests().map(identify).sort();
    process.stdout.write(`SHARDING${JSON.stringify({ plugin: this.plugin, playwright })}\n`);
  }
}
