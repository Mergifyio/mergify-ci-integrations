import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/runner.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    '@mergifyio/ci-core',
    '@opentelemetry/api',
    '@opentelemetry/core',
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/exporter-trace-otlp-proto',
    '@opentelemetry/resources',
  ],
});
