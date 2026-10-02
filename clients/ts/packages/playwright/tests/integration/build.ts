import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// The fixture's playwright.config.ts imports `withMergify` from the compiled
// dist, so it is built here, once, before any file runs. Built per file, it
// raced: tsdown empties dist before writing it, and the files run in
// parallel, so one file's build deleted the dist another file's Playwright
// was loading.
export default function setup(): void {
  const build = spawnSync('pnpm', ['-F', '@mergifyio/playwright', 'build'], {
    cwd: resolve(import.meta.dirname, '..', '..'),
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    throw new Error(`Package build failed:\n${build.stdout}\n${build.stderr}`);
  }
}
