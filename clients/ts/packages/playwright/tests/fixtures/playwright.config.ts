import { withMergify } from '@mergifyio/playwright';
import { defineConfig } from '@playwright/test';

const dir = process.env.PW_FIXTURE_DIR ?? './tests';

export default withMergify(
  defineConfig({
    testDir: dir,
    outputDir: './test-results',
    reporter: 'list',
    use: {},
    projects: [{ name: 'node' }],
  })
);
