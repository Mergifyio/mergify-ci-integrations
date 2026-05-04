import { join } from 'node:path';
import {
  detectResources,
  envToBool,
  fetchQuarantineList,
  generateTestRunId,
  getRepoName,
  isInCI,
  resolveBranchFromAttributes,
} from '@mergifyio/ci-core';
import type { FullConfig } from '@playwright/test';
import { type QuarantineState, stateFilePath, writeStateFile } from './state-file.js';

const DEFAULT_API_URL = 'https://api.mergify.com';

export interface RunGlobalSetupDeps {
  cacheRoot: string;
  now: () => Date;
}

function resolveBranch(testRunId: string): string | undefined {
  return resolveBranchFromAttributes(detectResources({}, testRunId).attributes);
}

export async function runGlobalSetup(config: FullConfig, deps: RunGlobalSetupDeps): Promise<void> {
  const enabled = isInCI() || envToBool(process.env.PLAYWRIGHT_MERGIFY_ENABLE, false);
  if (!enabled) return;

  const token = process.env.MERGIFY_TOKEN;
  const apiUrl = process.env.MERGIFY_API_URL ?? DEFAULT_API_URL;
  const repoName = getRepoName();

  const testRunId = generateTestRunId();
  process.env.MERGIFY_TEST_RUN_ID = testRunId;

  const branch = resolveBranch(testRunId);
  if (!token || !repoName || !branch) {
    return;
  }

  const log = (msg: string) => process.stderr.write(`[@mergifyio/playwright] ${msg}\n`);
  // `fetchQuarantineList` is soft — on any error it logs via `log` and returns
  // an empty set. We just persist whatever it returns; a fetch failure and a
  // genuinely-empty list are indistinguishable downstream, and the logger has
  // already surfaced the failure to the user.
  const list = await fetchQuarantineList({ apiUrl, token, repoName, branch }, log);

  const state: QuarantineState = {
    version: 1,
    testRunId,
    createdAt: deps.now().toISOString(),
    rootDir: config.rootDir,
    quarantinedTests: [...list],
  };

  const path = stateFilePath(deps.cacheRoot, testRunId);
  try {
    writeStateFile(path, state);
    process.env.MERGIFY_STATE_FILE = path;
  } catch (err) {
    process.stderr.write(`[@mergifyio/playwright] failed to write state file: ${String(err)}\n`);
  }
}

export default async function playwrightGlobalSetup(config: FullConfig): Promise<void> {
  const cacheRoot = join(config.rootDir, 'node_modules', '.cache');
  await runGlobalSetup(config, {
    cacheRoot,
    now: () => new Date(),
  });
}
