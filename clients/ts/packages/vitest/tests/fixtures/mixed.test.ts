import { describe, expect, it } from 'vitest';

describe('outer', () => {
  describe('inner', () => {
    it('passes', () => {
      expect(true).toBe(true);
    });

    it('fails', () => {
      expect(true).toBe(false);
    });
  });

  it.skip('is skipped', () => {
    expect(true).toBe(true);
  });
});
