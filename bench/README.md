# Bench

Runs the same small test suite through each Mergify test client, against
Mergify production, and checks what Mergify recorded. It exists because the
client regressions that mattered most never failed a CI job: a string attribute
uploaded as `true`, a language that was never sent, a summary line that
disappeared.

`.github/workflows/bench.yml` runs it on every push to `main`. Each client is
built from that commit and installed the way users install it: a wheel, a
platform gem, npm tarballs.

## What a run checks

Each client runs its suite in its own job, in two steps.

1. **`bench-run-suite`** runs the suite and checks the job's own output. The
   suite fails on purpose, so the exit code must be the expected one. The
   output must show the client's report and the framework's own summary line,
   and none of the client's known failure messages.
2. **`bench-verify`** polls Mergify's API until the run shows up, then compares
   each test's recorded framework, framework version, language, file path,
   function name and last conclusion with `expectations.yaml`. A mismatch is
   printed as a table and added to the job summary.

## The suite

| Test | Does | Expected conclusion |
|---|---|---|
| passes | nothing | passed |
| fails | raises `boom` | failed |
| skipped | skips | skipped |
| évènement | nothing, under a non-ASCII name | passed |

## Telling bench tests apart

Bench tests land in this repository's CI Insights, so they have to stay
distinguishable from any other suite reported here.

- **Job name.** Each client reports as `bench-<client>`. `bench-run-suite` sets
  it through `MERGIFY_TEST_JOB_NAME`, from `expectations.yaml`. Mergify keeps
  test history per job name, and `bench-verify` searches by it.
- **Test name.** Every test name contains `mergify_bench`. Mergify quarantines
  by repository and test name alone, so this is what keeps the bench from ever
  matching another suite's test. pytest and rspec take it from the file name,
  vitest and playwright from the `describe` block.

The workflow name doesn't work as a marker: a workflow called from another one
reports its caller's name.

## Changing a suite

`expectations.yaml` holds the exact name each client reports for each test. A
new or renamed test needs its entry there, in every client's section.

## Secrets

- `MERGIFY_BENCH_TOKEN`: a CI application key, used by the clients to upload.
- `MERGIFY_BENCH_ADMIN_TOKEN`: an admin application key, used by
  `bench-verify` to read tests back. The tests API accepts no other key type.

Until both are set, the workflow skips with a notice.

## Working on the tools

```sh
cd bench/tools
uv run ruff format . && uv run ruff check . && uv run mypy src tests && uv run pytest
```
