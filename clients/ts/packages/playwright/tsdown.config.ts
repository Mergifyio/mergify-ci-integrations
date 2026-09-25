import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/global-setup.ts',
    'src/global-teardown.ts',
    // Loaded by path in the listing subprocess (see src/shard.ts), so it has to
    // be a file of its own in dist, not folded into the index bundle.
    'src/listing-reporter.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  deps: {
    neverBundle: [/^@playwright\//, /^@opentelemetry\//],
  },
});
