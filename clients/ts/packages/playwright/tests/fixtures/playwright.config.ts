import { withMergify } from '@mergifyio/playwright';
import { defineConfig } from '@playwright/test';

const dir = process.env.PW_FIXTURE_DIR ?? './tests';
// Opt-in retries so an integration test can exercise the retries > 0 path
// (MRGFY-7767): quarantine-absorbed failures must still be caught when the
// project configures retries. Parse to a non-negative integer, falling back to
// 0 when unset or non-numeric so a bad value never reaches Playwright's config.
const retries = Math.max(0, Number.parseInt(process.env.PW_FIXTURE_RETRIES ?? '', 10) || 0);
// One project by default; the test-selection runs ask for two, so the same
// test collected twice under two identities goes through the real runner.
const projects = (process.env.PW_FIXTURE_PROJECTS ?? 'node').split(',').map((name) => ({ name }));

export default withMergify(
  defineConfig({
    testDir: dir,
    outputDir: './test-results',
    reporter: 'list',
    retries,
    use: {},
    projects,
  })
);
