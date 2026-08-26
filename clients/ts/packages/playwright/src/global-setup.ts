import { join } from 'node:path';
import {
  createApiClient,
  detectResources,
  envToBool,
  type FlakyDetectionContext,
  fetchFlakyDetectionContext,
  fetchQuarantineList,
  fetchTestSelection,
  generateTestRunId,
  getRepoName,
  isInCI,
  isTestSelectionDisabled,
  type MergifyApiClient,
  resolveBranchFromAttributes,
  resolveSelectionCoordinates,
  type TestSelection,
} from '@mergifyio/ci-core';
import type { Attributes } from '@opentelemetry/api';
import type { FullConfig } from '@playwright/test';
import { type SharedState, stateFilePath, writeStateFile } from './state-file.js';
import { readPluginVersion } from './version.js';

const DEFAULT_API_URL = 'https://api.mergify.com';

export interface RunGlobalSetupDeps {
  cacheRoot: string;
  now: () => Date;
  /**
   * Backend client, injectable so tests can drive the quarantine and
   * flaky-detection paths without a network or a native binding. Defaults to
   * the bundled Rust client.
   */
  createClient?: (config: {
    apiUrl: string;
    token: string;
    repoName: string;
  }) => MergifyApiClient | null;
}

export async function runGlobalSetup(config: FullConfig, deps: RunGlobalSetupDeps): Promise<void> {
  // Flaky-detection rerun subprocess: the parent has already populated the
  // state file and exported MERGIFY_TEST_RUN_ID / MERGIFY_STATE_FILE. Re-running
  // globalSetup here would re-fetch the quarantine and flaky-detection
  // contexts (extra API calls per shard) and overwrite the state file mid-run.
  if (process.env.MERGIFY_RERUN_FILE) return;

  const enabled = isInCI() || envToBool(process.env.PLAYWRIGHT_MERGIFY_ENABLE, false);
  if (!enabled) return;

  const token = process.env.MERGIFY_TOKEN;
  const apiUrl = process.env.MERGIFY_API_URL ?? DEFAULT_API_URL;
  const repoName = getRepoName();

  const testRunId = generateTestRunId();
  process.env.MERGIFY_TEST_RUN_ID = testRunId;

  // Build OTel resource attributes once. `resolveBranchFromAttributes` picks
  // `vcs.ref.base.name` (PR base) over `vcs.ref.head.name` (push branch / PR
  // head); flaky-detection mode is derived from the same split — a non-empty
  // base ref means PR-like context → "new" mode, otherwise "unhealthy".
  const attrs = detectResources({}, testRunId).attributes;
  const branch = resolveBranchFromAttributes(attrs);
  const baseRefAttr = attrs['vcs.ref.base.name'];
  const isPullRequest = typeof baseRefAttr === 'string' && baseRefAttr.length > 0;

  if (!token || !repoName || !branch) {
    return;
  }

  const createClient =
    deps.createClient ??
    ((target) =>
      createApiClient({
        ...target,
        clientName: '@mergifyio/playwright',
        clientVersion: readPluginVersion(),
      }));
  const client = createClient({ apiUrl, token, repoName });
  // No client means no native binding for this platform, or a repository name
  // the client rejected — the fail-open path, same as detection reporting
  // nothing.
  if (!client) return;

  const log = (msg: string) => process.stderr.write(`[@mergifyio/playwright] ${msg}\n`);
  // `fetchQuarantineList` is soft — on any error it logs via `log` and returns
  // an empty set. We just persist whatever it returns; a fetch failure and a
  // genuinely-empty list are indistinguishable downstream, and the logger has
  // already surfaced the failure to the user.
  const list = await fetchQuarantineList(client, branch, log);

  // Flaky detection is server-driven: always request the context and let the
  // server opt the repository in (200) or out (404). Same soft-fail shape as
  // quarantine — a null return means the feature is dormant, not an error.
  let flakyContext: FlakyDetectionContext | undefined;
  let flakyMode: 'new' | 'unhealthy' | undefined;
  const mode = isPullRequest ? 'new' : 'unhealthy';
  const ctx = await fetchFlakyDetectionContext(client, mode, log);
  if (ctx) {
    flakyContext = ctx;
    flakyMode = mode;
  }

  // Reduced merge-queue reruns. Asked for here — this is where the API client
  // lives, and globalSetup runs once per Playwright process, before any test
  // file is loaded. Applying the answer is the reporter's job: `preprocess` is
  // the only hook holding the collection to match a subset against.
  const testSelection = await loadTestSelection(client, attrs, log);

  const state: SharedState = {
    version: 1,
    testRunId,
    createdAt: deps.now().toISOString(),
    rootDir: config.rootDir,
    quarantinedTests: [...list],
    ...(flakyContext && { flakyContext }),
    ...(flakyMode && { flakyMode }),
    ...(testSelection && { testSelection }),
  };

  const path = stateFilePath(deps.cacheRoot, testRunId);
  try {
    writeStateFile(path, state);
    process.env.MERGIFY_STATE_FILE = path;
  } catch (err) {
    process.stderr.write(`[@mergifyio/playwright] failed to write state file: ${String(err)}\n`);
  }
}

/**
 * The test selection for this run, or undefined when nothing was served.
 *
 * Undefined covers three cases the reporter treats alike, by staying silent:
 * the user kill switch, a run whose own identity is incomplete (a missing head
 * SHA, pipeline, or job name — a request keyed on a partial identity could only
 * match the wrong run), and a dormant repository. All three mean the full
 * suite, which is also what a failure degrades to — but a failure comes back as
 * a real value so the end-of-run report can say so.
 */
async function loadTestSelection(
  client: MergifyApiClient,
  attrs: Attributes,
  log: (msg: string) => void
): Promise<TestSelection | undefined> {
  if (isTestSelectionDisabled()) return undefined;
  const coordinates = resolveSelectionCoordinates(attrs);
  if (!coordinates) return undefined;
  const selection = await fetchTestSelection(client, coordinates, log);
  // A dormant repository stays silent: nothing was served, so the end-of-run
  // block says nothing, exactly like the quarantine and flaky-detection
  // fetches. The shared module folds that case into a `full` answer reasoned
  // `not_requested` rather than returning null, so it is read off the reason
  // and not off nullness. A failure is NOT dormant — it is a real "run
  // everything" that a user whose reruns stopped shrinking needs to see.
  return selection.reason === 'not_requested' ? undefined : selection;
}

export default async function playwrightGlobalSetup(config: FullConfig): Promise<void> {
  const cacheRoot = join(config.rootDir, 'node_modules', '.cache');
  await runGlobalSetup(config, {
    cacheRoot,
    now: () => new Date(),
  });
}
