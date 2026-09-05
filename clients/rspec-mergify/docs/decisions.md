# rspec-mergify Design Decisions

Record of all decisions made during the design and implementation of rspec-mergify.

## Chronological List of Prompts

### Design Phase
1. "I have this project pytest-mergify a pytest plugin, I let you read what it does. I would like to do the same thing for rspec. Can you help me to create the project from scratch?"
2. "A" — full parity (tracing + flaky detection + quarantine + all CI integrations)
3. "A" — use standard `opentelemetry-sdk` and `opentelemetry-exporter-otlp` Ruby gems
4. "A" — modern only (Ruby >= 3.1, RSpec >= 3.12)
5. "C" — gem name `rspec-mergify`, module `Mergify::RSpec`
6. "B" — implement reruns at the Example level via `around(:each)` hook
7. "A" — GPL-3.0-only license
8. "yes" — project structure looks right
9. "yes" — CIInsights orchestrator design looks right
10. "yes" — Formatter design looks right
11. "yes" — Flaky detection design looks right
12. "yes" — Quarantine design looks right
13. "yes" — Resource detectors & utils design looks right
14. "yes" — Auto-loading, configuration & testing strategy looks right
15. "go" — approve spec, start implementation plan
16. "1" — subagent-driven development (dispatch subagent per task)

### Implementation Phase
17. (Implementation of Tasks 1-10 via subagent dispatching — scaffold, utils, resources, CIInsights, formatter, quarantine, flaky detection, configuration, integration tests, README)

### Post-Implementation Requests
18. "Can you complete the README with a development section, with things like how to run tests"
19. "Update the README then" — after discovering rbenv requirement
20. "Can you add a .github/ with workflow to run the CI, take a look at what we did for pytest-mergify"
21. "How can I release the gem"
22. "Can you create a GitHub Action" — for the release workflow
23. "commit"
24. (Release workflow bundler error report) — fixed by enabling `bundler-cache: true`
25. "commit"
26. (Release workflow `rake release` missing error) — fixed by adding `bundler/gem_tasks` to Rakefile
27. "Can we make the rspec-mergify version use git tags to get its number"
28. "I need to keep OIDC work" — keep using `rubygems/release-gem@v1` with OIDC
29. "commit"
30. "The checkout is wrong, we should checkout the tag of the released version"
31. "commit"
32. (Release workflow version `0.0.0.dev` error) — fixed by passing `GEM_VERSION` from tag and overriding rake tasks
33. "commit"
34. "Otherwise can you create another git repository in ../rspec-mergify-example with an example project" — with hourly CI, daily PR workflow, 2 passing tests, 1 broken, 1 flaky 20%
35. (OTLP exporter `trace_id` error report) — fixed by calling `span.to_span_data` in processor and adding error handling in formatter
36. "commit"
37. (Release workflow bundler-cache error again) — re-enabled `bundler-cache: true`
38. "commit"
39. (Release workflow `rake release` task not found) — already fixed by `bundler/gem_tasks`
40. "commit"
41. (Release workflow version still wrong `0.0.0.dev.1.gb221692`) — fixed version.rb to strip `v` prefix and produce valid RubyGems versions
42. "commit"
43. "In the example page I have this: pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests" — repository settings issue, not code
44. "In example repo, we need a job that run the test" — added CI workflow for PRs and test job in daily-pr
45. "The daily job don't need this new job" — removed test job from daily-pr
46. "It's weird that the budget is zero, no?" — fixed by calling `prepare_for_session` and `fill_metrics_from_report`
47. "Does new mode add the `cicd.test.new: true` tag?" — fixed by moving attribute assignment before `too_slow?` check
48. "Does tests exercise both values?" — referring to `_MERGIFY_TEST_NEW_FLAKY_DETECTION` true/false
49. "yes" — add tests for both values
50. (Rubocop offenses report from CI) — fixed formatter method length, spec structure, verified doubles
51. "Why do we set `_MERGIFY_TEST_NEW_FLAKY_DETECTION: true` in CI?" — removed from rspec-mergify CI (only needed in example repo)
52. "You're wrong" — it was indeed set in rspec-mergify CI, corrected
53. "Look like rerun_count is not set correctly can you take a look" — fixed by feeding rerun metrics into FlakyDetector after each rerun
54. "Can you add tests to cover these counters and the new tags" — added 12 tests for rerun counters and span attributes
55. "Does the test coverage look like the one we have on pytest-mergify" — gap analysis performed
56. "yes" — implement missing integration tests
57. "In the example repo can we put in the Gemfile to use always the latest version of rspec-mergify" — changed to `>= 0`
58. "commit"
59. "Can we update the example repo to allow running the hourly job manually with workflow_dispatch" — already had it
60. "Can you drop everything I asked and all questions/responses we had into a file?"
61. "The documentation does not have my initial prompt"
62. "I also want all post asks I had to fix various bugs and the final tests coverage"
63. "Do you have the list of all my prompts for this session to complete the file"

## Initial Prompt

> I have this project pytest-mergify a pytest plugin, I let you read what it does. I would like to do the same thing for rspec.
> Can you help me to create the project from scratch?

The reference implementation is [pytest-mergify](https://github.com/Mergifyio/pytest-mergify), a pytest plugin for Mergify Test Insights that provides OpenTelemetry tracing, flaky test detection with budget-based reruns, and test quarantine. The goal is to create a functionally equivalent gem for RSpec.

## Scope

**Q: For the initial version, which features do you want to port?**
- A) Full parity — tracing + flaky detection + quarantine + all CI integrations
- B) Core first — tracing only
- C) Tracing + quarantine

**Decision: A (Full parity)** — the API contracts are already defined by the Python implementation and the Mergify backend expects specific span attributes.

## OpenTelemetry Approach

**Q: For OpenTelemetry in Ruby, which approach do you prefer?**
- A) Use the `opentelemetry-sdk` and `opentelemetry-exporter-otlp` Ruby gems
- B) Build a minimal OTLP HTTP exporter from scratch
- C) Use the OpenTelemetry SDK but with a custom exporter

**Decision: A (Standard Ruby OTel gems)** — the Ruby OpenTelemetry ecosystem is mature and maintained by the CNCF.

## Ruby/RSpec Versions

**Q: What Ruby/RSpec versions should we target?**
- A) Modern only — Ruby >= 3.1, RSpec >= 3.12
- B) Broad compatibility — Ruby >= 2.7, RSpec >= 3.0
- C) Middle ground — Ruby >= 3.0, RSpec >= 3.10

**Decision: A (Modern only)** — Ruby 3.1+ gives access to modern Ruby features, RSpec 3.12+ has a stable formatter/reporter API.

## Gem Name & Module Structure

**Q: For the gem name and module structure, do you prefer?**
- A) `rspec-mergify` gem, `RSpecMergify` module
- B) `mergify-rspec` gem, `Mergify::RSpec` module
- C) `rspec-mergify` gem, `Mergify::RSpec` module

**Decision: C** — gem name `rspec-mergify` follows RSpec ecosystem conventions, `Mergify::RSpec` module namespace keeps the door open for `Mergify::Minitest` later.

## Flaky Detection Rerun Mechanism

**Q: How should we handle re-executing tests in RSpec for flaky detection?**
- A) Use `rspec-retry` style mechanisms
- B) Implement reruns at the `Example` level via formatter/hooks
- C) Re-run as a second pass using `RSpec::Core::Runner`

**Decision: B (Example level)** — hook into RSpec's `around(:each)` and re-invoke `example.run` with proper state clearing. Closest to the pytest approach.

## Architecture

**Q: What architecture for the RSpec integration?**
- A) Formatter-based only
- B) Full plugin via `RSpec.configure` only
- C) Hybrid — Formatter for reporting + Hooks for behavior

**Decision: C (Hybrid)** — Formatter observes (span creation, reporting); hooks modify (reruns, quarantine). Matches how the Python version separates concerns.

## License

**Q: What license?**
- A) GPL-3.0-only (same as pytest-mergify)
- B) MIT
- C) Apache-2.0

**Decision: A (GPL-3.0-only)** — consistency with pytest-mergify.

## Version Management

Gem version is derived from git tags via `git describe --tags`. Falls back to `0.0.0.dev` when no tags exist. Dev builds produce versions like `0.1.0.dev3` (valid RubyGems format). The `v` prefix is stripped automatically.

## Release Pipeline

Uses `rubygems/release-gem@v1` GitHub Action with OIDC trusted publishing (no API key secrets needed). The release workflow checks out the specific tag, sets `GEM_VERSION` from the tag name, and overrides rake's `release:source_control_push` and `release:guard_clean` tasks since Git tagging is handled by GitHub Releases.

## Self-Testing

rspec-mergify cannot use itself for testing because loading the gem triggers `CIInsights.new` and `Configuration.setup!`, which would conflict with the specs that test those components. A separate example project (`rspec-mergify-example`) is used for end-to-end validation.

## Post-Implementation Bugs & Fixes

### SpanData export crash
The `SynchronousBatchSpanProcessor#on_finish` was queuing raw `Span` objects, but the OTLP exporter expects `SpanData`. Fixed by calling `span.to_span_data` before queuing.

### Export error crashes rspec
`Formatter#flush_and_shutdown` didn't rescue errors from `force_flush`, so an OTLP export failure (e.g., 404 from the API) would crash the entire rspec process. Fixed by rescuing `StandardError` and printing a helpful troubleshooting message with common causes (missing token, Mergify Test Insights not enabled, network issues) and a link to documentation.

### Flaky detection budget always zero
`FlakyDetector#prepare_for_session` was never called, so `@tests_to_process` was empty and budget stayed at 0. Fixed by adding a `before(:suite)` hook in `Configuration` that calls `prepare_for_session` with all example IDs from `RSpec.world`.

### Flaky detection metrics not fed
`fill_metrics_from_report` was never called after the initial run or after reruns, so `TestMetrics.rerun_count` stayed at 1 and budget/deadline tracking was broken. Fixed by calling `fill_metrics_from_report` after every `example.run` (initial and reruns) in the `around(:each)` hook.

### cicd.test.new and cicd.test.flaky_detection set too late
These span attributes were only set inside the rerun loop, after the `test_too_slow?` check. Tests that were rerun candidates but too slow to actually rerun would not get these attributes. Fixed by moving the metadata assignment before the `test_too_slow?` early return, matching the Python behavior.

### Version not derived from git tags
The `version.rb` initially used `--match 'v*'` in `git describe`, but release tags were `0.0.1` (no `v` prefix). Fixed by removing the `--match` filter. Also fixed RubyGems-incompatible version strings (e.g., `v0.0.0.dev.3.g166da13`) by stripping the `v` prefix and converting git describe output to valid RubyGems format (`0.1.0.dev3`).

### Release workflow failures
Multiple issues with the release workflow:
- `rubygems/release-gem@v1` runs `bundle exec rake release` which needs `bundler/gem_tasks` in the Rakefile — added it.
- `rake release` tries to create git tags and push, conflicting with GitHub Releases — overrode `release:source_control_push` and `release:guard_clean` tasks.
- Checkout was on default branch instead of the release tag — added `ref: ${{ github.event.release.tag_name }}`.
- `bundler-cache` was disabled so gems weren't installed — re-enabled it.

### _MERGIFY_TEST_NEW_FLAKY_DETECTION in CI
The rspec-mergify CI workflow had `_MERGIFY_TEST_NEW_FLAKY_DETECTION: "true"` set, but this is a user-facing feature flag, not needed for the gem's own test suite. Removed.

## Test Coverage

### Final state: 195 tests, 0 failures, 0 rubocop offenses

### Coverage by area

| Area | Test file(s) | Examples |
|---|---|---|
| Utils (CI detection, git, repo parsing) | `utils_spec.rb` | 38 |
| Resource detectors (CI, Git, GHA, Jenkins, Mergify, RSpec) | `resources/*_spec.rb` | 27 |
| SynchronousBatchSpanProcessor | `ci_insights_spec.rb` | 5 |
| CIInsights orchestrator | `ci_insights_spec.rb` | 15 |
| Formatter (span creation, attributes, status) | `formatter_spec.rb` | 37 |
| Quarantine (API, matching, report) | `quarantine_spec.rb` | 18 |
| FlakyDetector (budget, metrics, reruns, report) | `flaky_detection_spec.rb` | 31 |
| Configuration hooks | `configuration_spec.rb` | 1 |
| Integration: Tracing (sandbox) | `integration/tracing_spec.rb` | 15 |
| Integration: Quarantine (sandbox) | `integration/quarantine_spec.rb` | 8 |
| Integration: Flaky Detection (sandbox) | `integration/flaky_detection_spec.rb` | 4 |

### Integration tests use a SandboxHelper

A `SandboxHelper` module runs real RSpec examples inside dynamically created `ExampleGroup`s, with a real `Formatter` and `InMemorySpanExporter`. This is the RSpec equivalent of pytest's `pytester` fixture.

### Comparison with pytest-mergify coverage

| Area | pytest-mergify | rspec-mergify | Status |
|---|---|---|---|
| Span attributes (pass/fail/skip) | Covered | Covered | Parity |
| Session span lifecycle | Covered | Covered | Parity |
| Parent-child span relationships | Covered | Covered | Parity |
| Distributed tracing (traceparent) | Covered | Covered | Parity |
| test.run.id resource attribute | Covered | Covered | Parity |
| Quarantine span suppression | Covered | Covered | Parity |
| Mixed quarantine/non-quarantine | Covered | Covered | Parity |
| No-CI behavior | Covered | Covered | Parity |
| Missing token warning | Covered | Covered | Parity |
| Missing repo warning | Covered | Covered | Parity |
| Flaky metadata on spans | Covered | Covered | Parity |
| Rerun count tracking | Covered | Covered (unit) | Parity |
| Budget/deadline enforcement | Covered | Covered (unit) | Parity |
| Actual rerun execution (pytester) | Covered | Not covered | Gap |
| HTTP trace upload (subprocess+server) | Covered | Not covered | Gap |

The two remaining gaps require either a process-level test harness or deeper sandbox support for exercising the `around(:each)` rerun loop and actual OTLP HTTP export end-to-end.
