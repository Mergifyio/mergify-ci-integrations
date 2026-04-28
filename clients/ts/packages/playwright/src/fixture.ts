import { relative } from 'node:path';
import { test as baseTest, expect, type TestInfo } from '@playwright/test';
import { readStateFile } from './state-file.js';
import { buildQuarantineKey, toPosix } from './utils.js';

interface ApplyArgs {
  testInfo: TestInfo;
  quarantineSet: ReadonlySet<string>;
  rootDir: string;
}

const FAILED_STATUSES = new Set(['failed', 'timedOut', 'interrupted']);

export function applyQuarantine({ testInfo, quarantineSet, rootDir }: ApplyArgs): void {
  if (quarantineSet.size === 0) return;
  const status = testInfo.status;
  if (status === undefined || !FAILED_STATUSES.has(status)) return;

  const filepath = toPosix(relative(rootDir, testInfo.file));
  const key = buildQuarantineKey(filepath, testInfo.titlePath, testInfo.title);
  if (!quarantineSet.has(key)) return;

  // Mirror the actual status. Playwright reconciles a test as "expected" only
  // when `status === expectedStatus`, so setting `expectedStatus = 'failed'`
  // for a `timedOut` or `interrupted` test would still report the test as a
  // failure. Mirroring makes the equality hold for any failure-class status.
  testInfo.expectedStatus = status;
  testInfo.annotations.push({ type: 'mergify:quarantined' });
}

// Worker-level cache, populated lazily on first fixture invocation.
let workerState: { quarantineSet: Set<string>; rootDir: string } | null = null;
let workerStateWarned = false;

function loadWorkerState(): { quarantineSet: Set<string>; rootDir: string } | null {
  if (workerState) return workerState;
  const path = process.env.MERGIFY_STATE_FILE;
  if (!path) return null;
  const state = readStateFile(path);
  if (!state) {
    if (!workerStateWarned) {
      workerStateWarned = true;
      process.stderr.write(
        '[@mergifyio/playwright] quarantine state file not found; quarantine disabled for this worker\n'
      );
    }
    return null;
  }
  workerState = { quarantineSet: new Set(state.quarantinedTests), rootDir: state.rootDir };
  return workerState;
}

export const test = baseTest.extend<{ mergifyQuarantine: void }>({
  mergifyQuarantine: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixture requires object-destructured first arg
    async ({}, use, testInfo) => {
      await use();
      const loaded = loadWorkerState();
      if (!loaded) return;
      applyQuarantine({
        testInfo,
        quarantineSet: loaded.quarantineSet,
        rootDir: loaded.rootDir,
      });
    },
    { auto: true, scope: 'test' },
  ],
});

export { expect };
