import { expect, test } from '@mergifyio/playwright';

test.describe('outer', () => {
  test('quarantined-fails', () => {
    expect(1).toBe(2);
  });

  test.describe('inner', () => {
    test('junit-quarantined-fails', () => {
      expect(1).toBe(2);
    });
  });
});
