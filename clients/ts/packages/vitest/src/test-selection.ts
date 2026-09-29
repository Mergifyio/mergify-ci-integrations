import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FinalStatus } from '@mergifyio/ci-core';
import type { TestSpecification, Vitest } from 'vitest/node';

/** Whether this Vitest exports its runner base class, `TestRunner`, from `vitest` (4.1 and later). */
function exportsTestRunner(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return major > 4 || (major === 4 && minor >= 1);
}

/**
 * The runner the reporter installs, which is what deselects tests.
 *
 * It is a sibling of this very module and always carries the same extension:
 * tsdown emits `index.mjs` next to `runner.mjs` and `index.cjs` next to
 * `runner.cjs`, and under vitest the sources run as `.ts`. There is no
 * `runner.js` in any of those worlds, so deriving the extension from the
 * module being executed is what keeps the pair in step — a hardcoded one
 * resolved to a file that ships in no build at all, and vitest then failed the
 * whole run with ERR_MODULE_NOT_FOUND the moment a repository had its first
 * quarantined test (#87).
 *
 * Which runner depends on the Vitest running: its base class is exported from
 * `vitest` since 4.1 and only from `vitest/runners` before, a subpath 4.1
 * deprecates and 5.0 removed. Loading the wrong one breaks the run the same
 * way a missing file does.
 */
export function mergifyRunnerPath(vitestVersion: string): string {
  const self = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const entry = exportsTestRunner(vitestVersion) ? 'runner' : 'runner-legacy';
  return resolve(dirname(self), `${entry}${extname(self)}`);
}

/**
 * Why this run cannot honour a selection, or undefined when it can.
 *
 * A selection is only as real as the runner that deselects: Vitest loads a
 * `config.runner` for the root project alone, and never in browser mode, where
 * the browser tester builds its own (MRGFY-9626). Anywhere else every served
 * answer would run the whole suite while the report claimed a reduction, and
 * the verdict would tell the next attempt a subset ran. Asking nothing is the
 * honest answer there, the same one a job that never opted in gets.
 */
export function selectionUnreachable(
  vitest: Vitest,
  specifications: ReadonlyArray<TestSpecification>
): string | undefined {
  const runner = vitest.config.runner;
  if (runner && runner !== mergifyRunnerPath(vitest.version)) {
    return `a custom runner is configured (${runner}), and only Mergify's can deselect tests`;
  }
  const root = vitest.getRootProject();
  for (const specification of specifications) {
    if (specification.project !== root) {
      return 'this run uses `test.projects`, where Vitest does not load the runner that deselects tests';
    }
    if (specification.project.config.browser?.enabled) {
      return 'this run uses browser mode, where Vitest does not load the runner that deselects tests';
    }
  }
  return undefined;
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
