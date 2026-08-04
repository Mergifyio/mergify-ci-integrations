import { describe, expect, it } from 'vitest';

describe('skipped suite', () => {
  it.skip('is skipped', () => {
    expect(true).toBe(true);
  });
});
