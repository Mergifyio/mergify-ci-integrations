import { relative, sep } from 'node:path';
import type { FinalStatus } from '@mergifyio/ci-core';
import type { TestSpecification, Vitest } from 'vitest/node';

/** Whether this Vitest exports its runner base class, `TestRunner`, from `vitest` (4.1 and later). */
export function exportsTestRunner(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return major > 4 || (major === 4 && minor >= 1);
}

/**
 * The files this leg of a `--shard` run executes, asked of the sequencer the
 * run itself shards with.
 *
 * `onTestRunStart` is handed every file of the suite: Vitest shards later, in
 * the pool, with `config.sequence.sequencer` — a hash of each file's path,
 * sorted and sliced. Fingerprinting the whole suite would give every shard the
 * same identity, so each would be served the failures of all of them and the
 * shards holding none would fail on the stale-subset guard. Asking the same
 * sequencer, rather than recomputing its slice here, keeps a custom sequencer
 * the user configured in charge of its own answer.
 */
export async function shardSlice(
  vitest: Vitest,
  specifications: ReadonlyArray<TestSpecification>
): Promise<ReadonlyArray<TestSpecification>> {
  if (!vitest.config.shard) return specifications;
  const Sequencer = vitest.config.sequence.sequencer;
  return new Sequencer(vitest).shard([...specifications]);
}

/**
 * What this leg is about to run, as the identifiers its fingerprint is taken
 * over: one per test file, plus the name filters applied inside them.
 *
 * Files and not tests, because the request has to leave before anything runs
 * and Vitest only knows its tests once each worker has imported its file.
 * Collecting them up front would import every file twice. The engine matches
 * a retry to its predecessor on this value together with the commit, and on
 * one commit the same files under the same filters collect the same tests, so
 * what the digest has to tell apart is the set of files — which is exactly
 * where two shards differ — and the filters that pick tests inside them. The
 * shard itself is named too.
 *
 * Paths are relative to the root and use `/`, so the value does not depend on
 * where the runner checked the repository out.
 */
export function collectionIdentity(
  vitest: Vitest,
  specifications: ReadonlyArray<TestSpecification>
): string[] {
  const root = vitest.config.root;
  const ids = specifications.map((specification) => {
    const path = relative(root, specification.moduleId).split(sep).join('/');
    const lines = specification.testLines?.length ? `:${specification.testLines.join(',')}` : '';
    return `file:${path}${lines}`;
  });
  // Two legs with no file at all would otherwise share the digest of
  // nothing, and Mergify refuses to choose between legs it cannot tell apart.
  const shard = vitest.config.shard;
  if (shard) ids.push(`shard:${shard.index}/${shard.count}`);
  const pattern = vitest.config.testNamePattern;
  if (pattern) ids.push(`testNamePattern:${String(pattern)}`);
  const tags = (vitest.config as { tagsFilter?: unknown }).tagsFilter;
  if (tags !== undefined && tags !== null) ids.push(`tagsFilter:${JSON.stringify(tags)}`);
  return ids;
}

/**
 * A test's final status for the verdict, from what the reporter saw of it.
 *
 * A failure the runner absorbed — quarantined, or rewritten to a pass by flaky
 * detection in unhealthy mode — did not gate the job, but it did run and fail:
 * it is neither replayed on the next attempt nor counted green.
 */
export function finalStatus(
  state: 'passed' | 'failed' | 'skipped',
  meta: Record<string, unknown>
): FinalStatus {
  if (meta.quarantined === true || meta.absorbedFailure === true) return 'quarantined_failed';
  return state;
}
