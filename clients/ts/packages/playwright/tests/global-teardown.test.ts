import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGlobalTeardown } from '../src/global-teardown.js';
import { stateFilePath } from '../src/state-file.js';

let cacheRoot: string;
beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'mergify-cache-'));
  process.env.MERGIFY_TEST_RUN_ID = 'abc123';
});
afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.MERGIFY_TEST_RUN_ID;
});

describe('runGlobalTeardown', () => {
  it('deletes the state file for the current run', () => {
    const path = stateFilePath(cacheRoot, 'abc123');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{}');
    runGlobalTeardown({ cacheRoot });
    expect(existsSync(path)).toBe(false);
  });

  it('is a no-op when the file does not exist', () => {
    expect(() => runGlobalTeardown({ cacheRoot })).not.toThrow();
  });

  it('is a no-op when MERGIFY_TEST_RUN_ID is not set', () => {
    delete process.env.MERGIFY_TEST_RUN_ID;
    expect(() => runGlobalTeardown({ cacheRoot })).not.toThrow();
  });

  it('writes to stderr (does not throw) on non-ENOENT errors', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Simulate by creating a directory at the state-file path; unlink fails with EISDIR/EPERM.
    const path = stateFilePath(cacheRoot, 'abc123');
    mkdirSync(path, { recursive: true });
    expect(() => runGlobalTeardown({ cacheRoot })).not.toThrow();
    expect(write).toHaveBeenCalledOnce();
  });
});
