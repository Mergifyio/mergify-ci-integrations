import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Each test body appends its name to the marker file, so a test asserting on
// selection can read which bodies ACTUALLY ran — not merely which ones were
// reported. Suppressing a deselected test from the upload and never executing
// it look identical from the session alone; this file tells them apart.
const marker = process.env.MERGIFY_SELECTION_MARKER;

function ran(name: string): void {
  if (marker) appendFileSync(marker, `${name}\n`);
}

describe('selection', () => {
  it('alpha', () => {
    ran('alpha');
    expect(1).toBe(1);
  });

  it('beta', () => {
    ran('beta');
    expect(1).toBe(1);
  });

  it('gamma', () => {
    ran('gamma');
    expect(1).toBe(1);
  });
});
