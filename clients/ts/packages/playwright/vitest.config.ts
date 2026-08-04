import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests rebuild the package and spawn playwright; opt in via
    // `pnpm test:integration`.
    exclude: ['**/node_modules/**', 'tests/integration/**'],
  },
});
