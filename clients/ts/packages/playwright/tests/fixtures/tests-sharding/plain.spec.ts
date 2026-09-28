// Plain parallel tests: under `fullyParallel` each one is its own group, so the
// partition may cut between any two of them.
import { expect, test } from '@playwright/test';

for (const i of [1, 2, 3, 4, 5, 6, 7]) {
  test(`plain ${i}`, () => {
    expect(i).toBeGreaterThan(0);
  });
}
