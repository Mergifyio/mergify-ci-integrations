import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { stateFilePath } from './state-file.js';

export interface RunGlobalTeardownDeps {
  cacheRoot: string;
}

export function runGlobalTeardown(deps: RunGlobalTeardownDeps): void {
  const id = process.env.MERGIFY_TEST_RUN_ID;
  if (!id) return;

  const path = stateFilePath(deps.cacheRoot, id);
  try {
    unlinkSync(path);
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') {
      return;
    }
    process.stderr.write(
      `[@mergifyio/playwright] failed to delete state file ${path}: ${String(err)}\n`
    );
  }
}

export default async function playwrightGlobalTeardown(config: FullConfig): Promise<void> {
  runGlobalTeardown({ cacheRoot: join(config.rootDir, 'node_modules', '.cache') });
}
