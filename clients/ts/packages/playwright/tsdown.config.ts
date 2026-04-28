import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/global-setup.ts', 'src/global-teardown.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  deps: {
    neverBundle: [/^@playwright\//, /^@opentelemetry\//],
  },
});
