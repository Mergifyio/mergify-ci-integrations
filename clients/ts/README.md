# Mergify CI plugins (pnpm monorepo)

Test-framework plugins that integrate with **Mergify CI Insights** — OpenTelemetry
trace upload for every test run.

More information at https://mergify.com

## Packages

| Package | Description |
|---|---|
| [`@mergifyio/vitest`](./packages/vitest) | Vitest reporter (with quarantine + flaky detection) |
| [`@mergifyio/playwright`](./packages/playwright) | Playwright reporter (tracing) |
| [`@mergifyio/ci-core`](./packages/core) | Shared core (tracing, resources, APIs) — internal |

See each package's README for installation and usage.

## Development

```bash
pnpm install
pnpm -r run build
pnpm -r test
```

Available root scripts:

| Command | What it does |
|---|---|
| `pnpm -r test` | Run every package's test suite |
| `pnpm -r run build` | Build every package |
| `pnpm run typecheck` | Type-check the workspace |
| `pnpm run eslint` | Lint `src/` and `tests/` across packages |
| `pnpm run format` | Format and auto-fix with Biome |
| `pnpm run format:check` | Check formatting with Biome |
