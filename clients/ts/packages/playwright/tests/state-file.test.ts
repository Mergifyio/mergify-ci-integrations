import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type QuarantineState,
  readStateFile,
  stateFilePath,
  writeStateFile,
} from '../src/state-file.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mergify-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sampleState(): QuarantineState {
  return {
    version: 1,
    testRunId: 'abc123',
    createdAt: '2026-04-21T16:07:42.123Z',
    rootDir: '/repo',
    quarantinedTests: ['tests/a.spec.ts > x'],
  };
}

describe('writeStateFile + readStateFile', () => {
  it('round-trips a valid state file', () => {
    const path = stateFilePath(dir, 'abc123');
    writeStateFile(path, sampleState());
    expect(readStateFile(path)).toEqual(sampleState());
  });

  it('returns null and warns when the file does not exist', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(readStateFile(join(dir, 'missing.json'))).toBeNull();
    // No warning for plain ENOENT — that's the "not configured" path.
    expect(write).not.toHaveBeenCalled();
  });

  it('returns null and warns when JSON is malformed', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ not json');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(readStateFile(path)).toBeNull();
    expect(write).toHaveBeenCalledOnce();
  });

  it('returns null and warns on unknown version', () => {
    const path = join(dir, 'future.json');
    writeFileSync(path, JSON.stringify({ ...sampleState(), version: 99 }));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(readStateFile(path)).toBeNull();
    expect(write).toHaveBeenCalledOnce();
  });

  it('returns null and warns when quarantinedTests is missing', () => {
    const path = join(dir, 'partial.json');
    const { quarantinedTests: _omit, ...incomplete } = sampleState();
    writeFileSync(path, JSON.stringify(incomplete));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(readStateFile(path)).toBeNull();
    const msg = write.mock.calls.map((c) => String(c[0])).join('');
    expect(msg).toMatch(/malformed shape/);
  });

  it('returns null and warns when quarantinedTests contains a non-string', () => {
    const path = join(dir, 'bad-entry.json');
    writeFileSync(path, JSON.stringify({ ...sampleState(), quarantinedTests: ['ok', 42] }));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(readStateFile(path)).toBeNull();
    const msg = write.mock.calls.map((c) => String(c[0])).join('');
    expect(msg).toMatch(/malformed shape/);
  });

  it('returns null and warns when rootDir is missing', () => {
    const path = join(dir, 'no-rootdir.json');
    const { rootDir: _omit, ...incomplete } = sampleState();
    writeFileSync(path, JSON.stringify(incomplete));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(readStateFile(path)).toBeNull();
    const msg = write.mock.calls.map((c) => String(c[0])).join('');
    expect(msg).toMatch(/malformed shape/);
  });
});

describe('stateFilePath', () => {
  it('builds a deterministic path under the cache dir', () => {
    expect(stateFilePath('/repo/node_modules/.cache', 'abc123')).toBe(
      '/repo/node_modules/.cache/@mergifyio/playwright/state-abc123.json'
    );
  });
});

describe('readStateFile — flaky detection fields', () => {
  it('round-trips flakyContext and flakyMode', () => {
    const path = join(dir, 'state-flaky.json');
    writeStateFile(path, {
      ...sampleState(),
      flakyContext: {
        budget_ratio_for_new_tests: 0.5,
        budget_ratio_for_unhealthy_tests: 0.5,
        existing_test_names: ['t1'],
        existing_tests_mean_duration_ms: 100,
        unhealthy_test_names: [],
        max_test_execution_count: 5,
        max_test_name_length: 200,
        min_budget_duration_ms: 1_000,
        min_test_execution_count: 3,
      },
      flakyMode: 'new',
    });

    const read = readStateFile(path);
    expect(read?.flakyContext?.existing_test_names).toEqual(['t1']);
    expect(read?.flakyMode).toBe('new');
  });

  it('keeps flakyMode when flakyContext is absent', () => {
    const path = join(dir, 'state-mode-only.json');
    writeStateFile(path, {
      ...sampleState(),
      flakyMode: 'unhealthy',
    });

    const read = readStateFile(path);
    expect(read?.flakyMode).toBe('unhealthy');
    expect(read?.flakyContext).toBeUndefined();
  });

  it('drops flakyMode when value is not "new" or "unhealthy"', () => {
    const path = join(dir, 'state-bad-mode.json');
    writeFileSync(path, JSON.stringify({ ...sampleState(), flakyMode: 'wibble' }));

    const read = readStateFile(path);
    expect(read?.flakyMode).toBeUndefined();
  });
});
