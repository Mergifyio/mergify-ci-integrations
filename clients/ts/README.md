# Mergify CI plugins (pnpm monorepo)

Test-framework plugins that integrate with **Mergify CI Insights** — OpenTelemetry
trace upload for every test run.

More information at https://mergify.com

## Packages

| Package | Description |
|---|---|
| [`@mergifyio/vitest`](./packages/vitest) | Vitest reporter (with quarantine + flaky detection) |
| [`@mergifyio/playwright`](./packages/playwright) | Playwright reporter (tracing + quarantine + flaky detection + reduced merge-queue reruns) |
| [`@mergifyio/ci-core`](./packages/core) | Shared core (tracing, resources, APIs) — internal |
| [`@mergifyio/ci-native`](./packages/native) | CI detection: napi binding over the repo's Rust core, prebuilt per platform — internal |

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

### Two TypeScript compilers

`package.json` installs TypeScript twice, under Microsoft's documented
side-by-side aliases:

| Installed as | Really | Gives you |
|---|---|---|
| `@typescript/native` | `typescript@7` | `tsc` — the native (Go) compiler, what `typecheck` runs |
| `typescript` | `@typescript/typescript6` | `import 'typescript'` — the classic compiler API, plus a `tsc6` binary |

TypeScript 7 is the native port and ships no importable compiler API until 7.1.
Anything that embeds the compiler rather than shelling out to it — typescript-eslint
here, for its type-aware rules — therefore still needs the classic one. The two
packages deliberately expose different binaries (`tsc` and `tsc6`), so they
coexist without either shadowing the other.
