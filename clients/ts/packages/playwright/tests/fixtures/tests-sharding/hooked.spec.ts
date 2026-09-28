// A `beforeAll` outside any sequential suite: Playwright pays it once per
// group, so it chunks the file into `ceil(n / legs)`-sized pieces instead of
// one group per test.
import { expect, test } from '@playwright/test';

test.beforeAll(() => {});

for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  test(`hooked ${i}`, () => {
    expect(i).toBeGreaterThan(0);
  });
}
