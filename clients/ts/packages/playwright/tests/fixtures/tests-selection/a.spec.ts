import { expect, test } from '@mergifyio/playwright';

test('a-passes', () => {
  expect(1).toBe(1);
});

test('a-fails', () => {
  expect(1).toBe(2);
});

test('a-flaky', ({}, testInfo) => {
  // Fails once, passes on the retry: a rescued test the verdict reads as passed.
  expect(testInfo.retry).toBeGreaterThan(0);
});
