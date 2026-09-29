import { appendFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

// A second file, so a `--shard` run has two slices to tell apart. Same marker
// protocol as `selection.test.ts`, plus the ways a run fails outside any test.
const marker = process.env.MERGIFY_SELECTION_MARKER;

describe('other', () => {
  beforeAll(() => {
    if (process.env.MERGIFY_SELECTION_BREAK_HOOK) throw new Error('broken hook');
  });

  it('delta', () => {
    if (marker) appendFileSync(marker, 'delta\n');
    if (process.env.MERGIFY_SELECTION_LEAK_REJECTION) void Promise.reject(new Error('leaked'));
    expect(1).toBe(1);
  });

  // Skipped by the author: never executed, whatever Mergify answers.
  it.skip('epsilon', () => {});
});
