import { defineConfig } from '@playwright/test';
import { withMergify } from '@mergifyio/playwright';

// No browser project: the bench tests never open a page.
export default withMergify(
  defineConfig({
    testDir: '.',
    testMatch: 'mergify_bench.spec.ts',
  }),
);
