import { expect, test } from '@mergifyio/playwright';

test('b-passes', () => {
  expect(1).toBe(1);
});

test('b-fails', () => {
  expect(1).toBe(2);
});
