import { expect, test } from '@mergifyio/playwright';

test('passes', () => {
  expect(1).toBe(1);
});

test('fails', () => {
  expect(1).toBe(2);
});

test('quarantined-fails', () => {
  expect(1).toBe(2);
});
