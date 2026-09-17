import { describe, it } from 'vitest';

describe('mergify_bench', () => {
  it('passes', () => {});

  it('fails', () => {
    throw new Error('boom');
  });

  it.skip('skipped', () => {});

  it('évènement', () => {});
});
