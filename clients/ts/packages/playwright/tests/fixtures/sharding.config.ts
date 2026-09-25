import { defineConfig } from '@playwright/test';

// Two projects that group differently: one parallelised down to the test, one
// left at Playwright's default where a file is a single group. The partition
// has to match Playwright's on both at once.
export default defineConfig({
  testDir: './tests-sharding',
  reporter: [[new URL('./sharding-probe.ts', import.meta.url).pathname]],
  projects: [
    { name: 'parallel', fullyParallel: true },
    { name: 'sequential', fullyParallel: false },
  ],
});
