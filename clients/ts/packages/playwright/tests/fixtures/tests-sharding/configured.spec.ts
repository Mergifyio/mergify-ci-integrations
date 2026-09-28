// `mode: 'default'` is sequential too, and groups exactly like `serial`.
import { expect, test } from '@playwright/test';

test.describe('defaulted', () => {
  test.describe.configure({ mode: 'default' });
  for (const i of [1, 2, 3]) {
    test(`configured ${i}`, () => {
      expect(i).toBeGreaterThan(0);
    });
  }
});

test('configured loner', () => {
  expect(1).toBe(1);
});
