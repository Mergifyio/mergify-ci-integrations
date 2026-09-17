import MergifyReporter from '@mergifyio/vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['mergify_bench.test.ts'],
    reporters: ['default', new MergifyReporter()],
  },
});
