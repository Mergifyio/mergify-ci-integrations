import { describe, expect, it } from 'vitest';

// Passes its first run and fails the second: a failure only a rerun sees.
let callCount = 0;

describe('late suite', () => {
  it('fails after its first attempt', () => {
    callCount++;
    expect(callCount).not.toBe(2);
  });
});
