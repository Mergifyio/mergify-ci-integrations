import { test } from '@mergifyio/playwright';

test.describe('mergify_bench', () => {
  test('passes', async () => {});

  test('fails', async () => {
    throw new Error('boom');
  });

  test.skip('skipped', async () => {});

  test('évènement', async () => {});
});
