import { defineConfig } from '@playwright/test';

// The canonical sharded e2e layout: an auth project every leg depends on.
// Playwright re-attaches the setup project to every leg AFTER sharding, so a
// listing that counted it would never match a collection that cannot hold it.
export default defineConfig({
  reporter: [[new URL('../sharding-probe.ts', import.meta.url).pathname]],
  projects: [
    { name: 'setup', testDir: '.', testMatch: /auth\.setup\.ts/ },
    { name: 'main', testDir: './tests', dependencies: ['setup'] },
  ],
});
