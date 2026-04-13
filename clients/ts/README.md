# vitest-mergify

A **vitest** plugin that integrates seamlessly with **Mergify**, enabling
tracing of test executions.

More information at https://mergify.com

## Installation

Install the package as a dev dependency alongside `vitest` (>= 3.0.0):

```bash
npm install --save-dev @mergifyio/vitest
```

## Usage

Register `MergifyReporter` in your `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import MergifyReporter from '@mergifyio/vitest';

export default defineConfig({
  test: {
    reporters: ['default', new MergifyReporter()],
  },
});
```

Set `MERGIFY_TOKEN` in your CI environment so the reporter can upload test
traces. Without it, the reporter stays silent and tests run normally.

## Development

Clone the repo and install dependencies:

```bash
npm install
```

Available scripts:

| Command                 | What it does                                   |
| ----------------------- | ---------------------------------------------- |
| `npm test`              | Run the test suite once (`vitest run`)         |
| `npm run test:watch`    | Run tests in watch mode                        |
| `npm run eslint`        | Lint `src/` and `tests/` with ESLint           |
| `npm run format`        | Format and auto-fix with Biome                 |
| `npm run format:check`  | Check formatting with Biome (no writes)        |
| `npm run typecheck`     | Type-check with `tsc --noEmit`                 |
| `npm run build`         | Bundle the package with `tsup`                 |
