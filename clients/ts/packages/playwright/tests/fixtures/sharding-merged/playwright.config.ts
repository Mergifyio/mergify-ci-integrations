import { defineConfig } from '@playwright/test';

// `testDir` defaults to this directory, so a run started from here has
// `rootDir === cwd` -- the condition under which Playwright's JSON reporter
// merges specs across projects. The fixtures that do not meet it cannot see
// the defect this one exists for.
export default defineConfig({
  reporter: [[new URL('../sharding-probe.ts', import.meta.url).pathname]],
  projects: [{ name: 'chromium' }, { name: 'firefox' }, { name: 'webkit' }],
});
