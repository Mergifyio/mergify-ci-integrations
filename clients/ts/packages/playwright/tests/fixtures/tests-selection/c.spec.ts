import { expect, test } from '@mergifyio/playwright';

// A serial group: once `c-first` fails, Playwright reports the followers as
// skipped without having run them.
test.describe.configure({ mode: 'serial' });

test('c-first', () => {
  expect(1).toBe(2);
});

test('c-second', () => {
  expect(1).toBe(1);
});

test('c-third', () => {
  expect(1).toBe(1);
});
