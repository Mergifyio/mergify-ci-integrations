import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/runner.ts', 'src/runner-legacy.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  deps: {
    neverBundle: [/^@vitest\//, /^@opentelemetry\//],
  },
});
