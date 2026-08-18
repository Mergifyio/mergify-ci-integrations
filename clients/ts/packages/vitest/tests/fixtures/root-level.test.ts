import { expect, it } from 'vitest';

// No describe block: the uploaded name is the bare test name, with no
// namespace to prefix it.
it('fails outside any suite', () => {
  expect(true).toBe(false);
});
