import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/setup.ts',
    'src/setup-legacy.ts',
    'src/setup-browser.ts',
    'src/setup-browser-legacy.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  deps: {
    neverBundle: [/^@vitest\//, /^@opentelemetry\//],
  },
});
