import { withMergify } from '@mergifyio/playwright';
import { defineConfig } from '@playwright/test';

export default withMergify(
  defineConfig({
    testDir: './tests',
    outputDir: './test-results',
    reporter: 'list',
    use: {},
    projects: [{ name: 'node' }],
  })
);
