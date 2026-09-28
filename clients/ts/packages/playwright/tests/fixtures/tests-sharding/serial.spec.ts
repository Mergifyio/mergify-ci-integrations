// A serial describe runs in order in one worker, so its tests are one group --
// and the test outside it is a group of its own.
import { expect, test } from '@playwright/test';

test.describe
  .serial('ordered', () => {
    for (const i of [1, 2, 3, 4]) {
      test(`serial ${i}`, () => {
        expect(i).toBeGreaterThan(0);
      });
    }
  });

test('serial loner', () => {
  expect(1).toBe(1);
});
