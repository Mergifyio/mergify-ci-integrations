import { describe, expect, it } from 'vitest';

// Module-level counter persists across repeats (vitest re-runs the test
// function without re-importing the module), simulating flaky behavior.
let callCount = 0;

describe('flaky suite', () => {
  it('intermittent test', () => {
    callCount++;
    if (callCount % 2 === 1) {
      // Odd runs fail
      expect(true).toBe(false);
    }
    // Even runs pass
    expect(true).toBe(true);
  });
});
