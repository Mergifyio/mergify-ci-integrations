# Reduced merge-queue reruns for `@mergifyio/vitest` (MRGFY-8685)

When the merge queue reruns a CI that failed, Mergify knows which tests failed on
the predecessor's attempt. `pytest-mergify` replays only those. This document
decides how `@mergifyio/vitest` does the same — and, above all, *at which level*
it must act, because the answer is not the one the reporter API suggests.

Scope: the Vitest client only. Playwright is a separate track.

## 1. The question that had to be settled first

A reporter observes; it cannot decide what runs. That is what made an earlier
pass conclude "impossible". But `MergifyRunner` (`src/runner.ts`) already proves a
channel into execution exists: the reporter injects state through
`vitest.provide` and the runner reads it with `injectValue`. The real question was
never "is there a channel", it was:

> **At what level can Vitest avoid doing the work, and how much does each level
> actually save?**

Skipping *tasks* does not avoid importing the test module, nor its
file-level setup. If import dominates, task-level filtering buys little and the
feature is not worth its cost. So: measure first.

## 2. Measurements

### 2.1 Real suite — the Mergify dashboard

`upstream-dashboard-ui`, Vitest 4.1.1, browser pool (Playwright chromium),
**224 test files, 2108 tests**. Wall clock is `/usr/bin/time -p` `real`; the
breakdown is Vitest's own.

| | scenario | wall clock | Vitest breakdown |
|---|---|---|---|
| **A** | full run | **205.8 s** | setup 13.4 s, import 44.1 s, tests 111.4 s |
| **B** | every task skipped, every file still imported | **70.1 s** | setup 8.9 s, import 36.0 s, **tests 0 ms** |
| **C** | 6 files loaded, 3 tests run | **2.65 s** | setup 0.33 s, import 0.45 s, tests 13 ms |

**B** is the *ceiling* of any task-level mechanism: all 2108 tests skipped, nothing
left to save. It was produced with Vitest's own `--testNamePattern` matching
nothing — the most favourable possible task-level filter.

Reading:

- Task-level filtering saves **66 %** and leaves **70 seconds** on the table.
- File-level filtering leaves **2.65 s** — **26× better than the task level**, 98.7 %
  of the full run removed.
- The 70 s floor is not overhead we can tune away: it is 224 modules being
  imported so that every test in them can be skipped.

### 2.2 Synthetic control (node pool, Vitest 4.1.10)

To confirm the ratio is not an artefact of the browser pool, and to isolate the
fixed startup cost. Startup floor (one trivial file): **439 ms**.

| suite (200 files) | full | task-skip | 1 file | task saves | file saves |
|---|---|---|---|---|---|
| import 40 ms / test 4 ms | 3849 ms | 2901 ms | 443 ms | 25 % | **88 %** |
| import 15 ms / test 15 ms | 5088 ms | 2652 ms | 545 ms | 48 % | **89 %** |

The task-level saving swings with the import/test mix (25 %–66 % across every
point measured). The file-level saving does not: it removes both terms at once,
and lands at 88–99 % regardless of the suite's shape. That stability is the
reason to prefer it.

### 2.3 What pytest actually saves

Worth stating, because "the same thing as pytest" is the brief.
`pytest-mergify` filters in `pytest_collection_modifyitems`, and pytest has
already **imported every test module** by the time that hook runs. So the pytest
plugin's reduced rerun also pays the full import cost: it is a task-level
mechanism too.

**Task-level for Vitest is therefore exact parity with pytest. File-level exceeds
it.**

## 3. What Vitest actually offers

Read from the installed sources (`vitest@4.1.10`, `@vitest/runner@4.1.10`) and
verified by running, not from memory.

### 3.1 The task level: `VitestRunner.onCollected` — documented, v3 and v4

```js
const files = await collectTests(specs, runner);  // interpretTaskModes ran inside
await runner.onCollected?.(files);                // ← here
await runner.onBeforeRunFiles?.(files);
```
`@vitest/runner/dist/chunk-artifact.js:3278-3280`

`onCollected` is part of the public `VitestRunner` interface, it runs **after**
every user filter has been applied and **before** anything executes. Setting
`task.mode = 'skip'` there can only ever remove work.

That it can only narrow is structural, not a convention —
`interpretTaskModes` (`chunk-artifact.js:963-972`) applies the name pattern,
`testIds` and tag filters as successive passes that only assign `'skip'`, never
un-skip. Anything applied at or after that point intersects with the user's
filters by construction.

### 3.2 The file level: a custom sequencer — documented, v3 and v4

`sequence.sequencer` takes a `TestSequencer` class; `BaseSequencer` is exported
from `vitest/node`. Its `sort(specs)` returns `Awaitable<TestSpecification[]>`.
Returning a **subset** drops those files entirely — verified by running:
20 files → 1 file, import 822 ms → 33 ms, no error.

**Constraint, and it is a sharp one:** the sequencer must return *the same
objects*, filtered. `createPool` builds the environment map from the **pre-sort**
list and looks it up by object identity on the **post-sort** list
(`cli-api.BK8pd4xc.js:3626-3628`), so a freshly-built specification throws
`Cannot find the environment. This is a bug in Vitest.` Filter, never rebuild.

### 3.3 Three traps, and the one that is already biting

**Trap A — `testNamePattern` replaces the user's filter instead of intersecting.**
```js
interpretTaskModes(file, testNamePattern ?? config.testNamePattern, …)
```
`chunk-artifact.js:2497`. A per-specification pattern *overrides* the global one.
Setting it would **widen** a run where the user passed `-t`, violating the rule
that our filter applies last and never enlarges what was asked for.

**Trap B — three different name shapes are in circulation.** For one test in
`failing.test.ts`, `describe('math')`, `it('fails intentionally')`:

| shape | value | where |
|---|---|---|
| runner-side `Task.fullName` | `failing.test.ts > math > fails intentionally` | `@vitest/runner`; **includes the file** as root suite |
| reporter-side `TestCase.fullName` | `math > fails intentionally` | `vitest/node`; getter stops at `parent.type === 'module'` (`cli-api:11616`) |
| `getTaskFullName` | `math fails intentionally` | what `testNamePattern` matches — **space-joined** (`chunk-artifact.js:1006-1008`) |

Measured for the third: a ` > `-joined pattern matched **0 of 88** tests.

**Trap C — the first two shapes are already mismatched in shipped code, and
quarantine cannot fire because of it.** The reporter uploads the *reporter-side*
shape (`spans.ts:88-90` builds the span name as `namespace > function`), so the
server can only ever serve that back. But `MergifyRunner.isQuarantined()`
compares against the *runner-side* shape (`src/runner.ts:117`), which carries a
file prefix the served name never has.

Verified by running, not by reading:

- the uploaded span name for the `failing.test.ts` fixture is
  `"math > fails intentionally"`;
- feeding exactly that string as `quarantineList` leaves the session **`failed`** —
  the failure is not absorbed;
- `tests/runner.test.ts:19` only passes because it feeds
  `'failing.test.ts > math > fails intentionally'`, a string this client never
  produces. **The tests encode the bug.**

Flaky detection keys on the same runner-side shape (`src/runner.ts:61,77,87`)
against server-provided `existing_test_names` / `unhealthy_test_names`, so it is
exposed to the identical mismatch.

**Consequences for this design.** Task-level narrowing belongs in the runner —
but it must match the **reporter-side** shape, rebuilt from the suite chain
stopping at the file task, so the string compared is byte-for-byte the string
uploaded. Both should come from one shared helper; two independent
constructions of "the test's name" is what produced Trap C.

### 3.4 Supported versions — measured, not assumed

Peer dependency is `vitest >= 3.0.0`. Against **3.2.7**:

| API | v3.2.7 | v4.1.10 |
|---|---|---|
| `BaseSequencer` (value export) | ✅ | ✅ |
| `VitestRunner.onCollected` | ✅ | ✅ |
| `vitest.provide` / `injectValue` | ✅ | ✅ |
| `globTestSpecifications` | ✅ | ✅ |
| `experimental_parseSpecifications` | ❌ **absent** | ✅ |

Everything this design needs exists on both. The one API that does not exist on
v3 is the one this design deliberately does **not** use — see §5.

## 4. The missing input, and where it already exists

File-level filtering needs one thing: **which file holds each served test name.**

The selection endpoint serves `SpanTest.span_name`
(`engine/mergify_engine/ci_insights/failing_tests.py`). And there the two clients
diverge:

| client | `span_name` | carries the file? |
|---|---|---|
| pytest | `item.nodeid` → `tests/test_a.py::test_x` | **yes** |
| vitest | `namespace > function` → `MyComponent > renders` | **no** |

But the file path *is* ingested and stored — `test_filepath`, populated from the
`code.filepath` attribute this client already emits
(`engine/mergify_engine/ci_insights/traces/processing_tests.py:89`,
`models/ci_insights/span/span_test.py:185`). The endpoint simply does not serve
it.

**So the blocker is not Vitest. Vitest offers everything needed. The blocker is
an identity asymmetry: for Vitest, the served identifier drops a column the
database already holds.**

## 5. The route not taken, and why

Vitest 4 can recover the mapping locally: `experimental_parseSpecifications`
parses test files' ASTs **without executing them**. Measured on the dashboard
suite: **478 ms to parse all 224 files** (591 ms including startup) against 44 s of
real imports — ~90× cheaper — and it yields `fullName` in exactly the ` > ` form
the server serves.

It is genuinely tempting. It is still the wrong route, because it needs three
workarounds stacked on each other:

1. AST-parse locally to recover a file path the server already has but does not send;
2. it sees **2052 of 2108** tests — 56 dynamically-generated ones are invisible, so
   any served name it cannot place forces a full-suite fallback;
3. it does not exist on Vitest 3, so it needs a second code path or dropping a
   supported version.

Three workarounds to substitute for one missing field is the signal that the
direction is wrong. Recorded here so it is not rediscovered and mistaken for a
shortcut.

## 6. Design

> **Decision, 2026-08-14: Layer 1 ships. Layer 2 is frozen.**
>
> Layer 2's extra 67 seconds are measured on *our own* suite. No customer has
> reported a Vitest merge-queue rerun as too slow, and we do not know which
> customers run Vitest in the queue at all — so the optimisation arrives without
> the measurement that would justify it, while costing an identifier change plus
> a migration of every per-test history row. Layer 1 is the boring version:
> −66 %, no server change, no identifier change, no migration, and exact parity
> with what pytest does today. Layer 2 stays documented here for the day a
> number justifies it; §4 is deliberately **not** being asked of the engine team.

Two layers. The runner layer is the whole feature minus one input; the sequencer
layer is purely additive on top of it and changes no runner code — which is
precisely what makes freezing it cost nothing now.

```
reporter (node, onInit)          runner (worker)              sequencer (node)
  fetch selection  ──provide──▶  onCollected:                 sort():
  (Rust client)                  skip every collected test    drop every file
                                 whose fullName ∉ subset      holding no selected
                                                              test
```

### Layer 1 — task level (no server change; pytest parity; −66 %)

- The reporter fetches the selection through the shared Rust client and injects
  it with `vitest.provide('mergify:selection', …)`, exactly as quarantine and
  flaky context already are.
- `MergifyRunner.onCollected(files)` walks the collected tree and sets
  `mode = 'skip'` on every test whose name is not in the subset. It runs after
  every user filter and can only narrow (§3.1).
- The name compared is the **reporter-side** shape (`namespace > function`,
  no file prefix) — the one actually uploaded and therefore the only one the
  server can serve back. Per Trap C (§3.3) this must come from a helper shared
  with the reporter, so the matched string cannot drift from the uploaded one.

### Layer 2 — file level (needs §4 resolved; −98.7 %)

- A `BaseSequencer` subclass filters the specification list down to the files
  holding at least one selected test, returning the same objects (§3.2).
- Layer 1 still narrows within each kept file, since a kept file also holds tests
  that were not selected.

### Safety rules — carried over from `pytest-mergify`, framework-independent

1. **Any error, timeout, or unrecognised answer runs the full suite.** The Rust
   client already returns `Dormant` on 402/404 and `Failed` otherwise; a `full`
   answer, and a `subset` whose list is empty, both mean run everything.
2. **The subset is intersected with what Vitest actually collected.** A served
   name missing from the collection is ignored — the test may legitimately have
   been deleted — but a subset matching *nothing* means the identifiers are
   stale and the run skipped everything.
3. **The filter applies last**, after the user's filters — structural here (§3.1),
   not a convention to remember.
4. **No green without having run what we believed we ran.** This is the rule that
   forbids reusing the quarantine mechanism, which rewrites a failure into a
   success *after* the test ran: for selection the execution *is* the cost, so
   rewriting afterwards saves nothing and would fabricate a result.
5. **Layer 2 may only drop a file whose every selected test is accounted for
   elsewhere.** A served name that cannot be placed in a file forces the full
   suite rather than a silent drop. (Frozen with Layer 2.)

#### Where rule 2 deviates from pytest, and why

pytest degrades a stale subset to running the full suite, because
`pytest_collection_modifyitems` sees the *whole* collection before anything
runs. Vitest collects inside the workers, in batches — `onCollected` receives one
worker's files, never the run's complete collection — so "did the subset match
anything at all?" is only answerable once the workers are done. By then the full
suite can no longer be substituted.

So the invariant is upheld later and louder: the reporter computes the global
intersection in `onTestRunEnd`, and when it is empty **fails the run** with an
explicit message pointing at `MERGIFY_TEST_SELECTION_DISABLE`. Same guarantee —
a run that executed nothing never reports green — reached by failing rather than
by falling back. This is the one place the two clients differ, and it is a
consequence of where each framework collects, not of a choice.

The guard reads the *matched* count, not the executed one: a served test the
user's own filter excluded is their decision, not a broken selection. And it
only fires on a **non-empty** served subset: an empty one means "nothing to
replay" (MRGFY-8614) and must never redden a branch that was green — every path
building a selection goes through one normaliser so that cannot be skipped.

**The known cost of failing rather than falling back.** On a matrix job whose
branches share a job name — the normal shape on GitHub Actions — the stored set
is the *union* of every branch's failures. A branch that was itself green
receives its sibling's tests, matches none of them, and goes red where pytest
would have rerun everything and passed.

That is accepted deliberately, because "I match nothing" covers two situations
the client cannot tell apart: *I was green* (benign) and *I was cancelled last
attempt, so my failures are in nobody's set* (a failing test that would never be
replayed). Until the missing fact — did this branch report at all last run? —
exists client-side, a visible red is the better default than a green that skips
a cancelled branch. Tracked against the pilot rollout (MRGFY-8113): this must be
closed before the rollout reaches a Vitest customer. No Vitest client is in the
pilot today, which is why it does not block.

### Reporting

Deselected tests are **not reported at all** — not even as `skipped`. A test that
never ran has no result, and the server counts `skipped` executions in its
per-test health statistics, so reporting one would feed it an outcome no run
produced. This matches pytest, whose deselected items are likewise never
reported. The end-of-run block is where the run says how many tests were removed
and why.

## 7. Work this implies

- **This repo, Layer 1** — done: `fetchTestSelection` exposed on the napi binding
  (it existed in the Rust client and the pytest binding but not on `CiApiClient`),
  `fetchTestSelection` in `@mergifyio/ci-core` carrying the normalisation, the
  reporter fetch/provide/report, and `MergifyRunner.onCollected`.
- **Engine, to unlock Layer 2** — deliberately not requested (see the decision
  box in §6). Should a number ever justify Layer 2: serve the file path alongside
  each test identifier for clients whose identifier does not carry one. The data
  is already stored; it is a response-shape change, not a data change.

## 8. Findings surfaced along the way (own tickets, not this scope)

1. **Quarantine cannot fire in production** — the shipped client matches a name
   shape it never uploads (§3.3, Trap C). Proven by running. Flaky detection is
   exposed to the same mismatch. This is a live defect, independent of reduced
   reruns, and it is why §6 insists on a single shared name helper.

2. **Even once the shapes agree, the identifier is ambiguous.** Since Vitest's
   identifier carries no file path (§4), two tests in different files sharing the
   same `describe` + test name are indistinguishable — quarantining one
   quarantines the other. Resolving §4 resolves this too.
