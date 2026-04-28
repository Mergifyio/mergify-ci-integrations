import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type { FullConfig, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergifyReporter } from '../src/reporter.js';
import { stateFilePath } from '../src/state-file.js';

function fakeConfig(): FullConfig {
  return { rootDir: '/root' } as unknown as FullConfig;
}

function fakeSuite(): Suite {
  return {} as Suite;
}

function fakeTest(
  overrides: {
    title?: string;
    titlePath?: string[];
    location?: { file: string; line: number; column: number };
    retries?: number;
    parent?: unknown;
    outcome?: () => 'expected' | 'unexpected' | 'flaky' | 'skipped';
    annotations?: Array<{ type: string; description?: string }>;
  } = {}
): TestCase {
  return {
    title: overrides.title ?? 'my test',
    titlePath: () => overrides.titlePath ?? ['chromium', '/root/tests/x.spec.ts', 'my test'],
    location: overrides.location ?? {
      file: '/root/tests/x.spec.ts',
      line: 42,
      column: 1,
    },
    retries: overrides.retries ?? 0,
    results: [] as TestResult[],
    parent: overrides.parent ?? ({ project: () => ({ name: 'chromium' }) } as unknown),
    outcome: overrides.outcome ?? (() => 'expected'),
    annotations: overrides.annotations ?? [],
  } as unknown as TestCase;
}

function fakeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    status: 'passed',
    duration: 20,
    startTime: new Date(1_000_000),
    retry: 0,
    errors: [],
    ...overrides,
  } as unknown as TestResult;
}

describe('MergifyReporter session lifecycle', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts a session span with test.scope=session and name "playwright session start"', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const session = spans.find((s) => s.attributes['test.scope'] === 'session');
    expect(session).toBeDefined();
    expect(session!.name).toBe('playwright session start');
  });

  it('getSession() exposes a session with 16-char hex testRunId', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const session = reporter.getSession();
    expect(session).toBeDefined();
    expect(session!.testRunId).toMatch(/^[0-9a-f]{16}$/);
    expect(session!.scope).toBe('session');
    expect(session!.startTime).toBeGreaterThan(0);
    expect(session!.endTime).toBeGreaterThanOrEqual(session!.startTime);
    expect(session!.status).toBe('passed');
  });

  it('sets session.status to failed when onEnd result status is failed', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    expect(reporter.getSession()!.status).toBe('failed');
  });
});

describe('onTestEnd — passing test', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits a test case span with code.* attributes', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({
      title: 'adds numbers',
      titlePath: ['chromium', '/root/tests/math.spec.ts', 'math', 'adds numbers'],
      location: { file: '/root/tests/math.spec.ts', line: 15, column: 3 },
    });
    reporter.onTestEnd(test, fakeResult({ status: 'passed', duration: 5 }));
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case');
    expect(testSpan).toBeDefined();
    expect(testSpan!.attributes['code.function']).toBe('adds numbers');
    expect(testSpan!.attributes['code.namespace']).toBe('tests/math.spec.ts > math');
    expect(testSpan!.attributes['code.lineno']).toBe(15);
    expect(testSpan!.attributes['code.filepath']).toBe('tests/math.spec.ts');
    expect(testSpan!.attributes['code.file.path']).toBe('/root/tests/math.spec.ts');
    expect(testSpan!.attributes['test.case.result.status']).toBe('passed');
    expect(testSpan!.attributes['cicd.test.retry_count']).toBe(0);
  });

  it('pushes a TestCaseResult to the session', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const session = reporter.getSession()!;
    expect(session.testCases).toHaveLength(1);
    expect(session.testCases[0].status).toBe('passed');
    expect(session.testCases[0].function).toBe('my test');
  });

  it('makes the test case span a child of the session span', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const session = spans.find((s) => s.attributes['test.scope'] === 'session')!;
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case')!;
    expect(testSpan.parentSpanContext?.spanId).toBe(session.spanContext().spanId);
  });
});

describe('onTestEnd — failing test', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets exception.* attributes and ERROR status when the test fails', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({ outcome: () => 'unexpected' });
    reporter.onTestEnd(
      test,
      fakeResult({
        status: 'failed',
        errors: [
          {
            message: 'Expected 2 but got 3',
            stack: 'Error: at some.file.ts:10',
            value: 'Error: Expected 2 but got 3',
          } as TestResult['errors'][number],
        ],
      })
    );
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const testSpan = spans.find((s) => s.attributes['test.scope'] === 'case')!;
    expect(testSpan.attributes['test.case.result.status']).toBe('failed');
    expect(testSpan.attributes['exception.type']).toBe('Error');
    expect(testSpan.attributes['exception.message']).toBe('Expected 2 but got 3');
    expect(testSpan.attributes['exception.stacktrace']).toBe('Error: at some.file.ts:10');
  });

  it('treats timedOut as failed', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult({ status: 'timedOut' }));
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    const tc = reporter.getSession()!.testCases[0];
    expect(tc.status).toBe('failed');
  });
});

describe('onTestEnd — skipped test', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits status=skipped with no exception attributes', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(
      fakeTest({ outcome: () => 'skipped' }),
      fakeResult({ status: 'skipped', errors: [] })
    );
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const tc = spans.find((s) => s.attributes['test.scope'] === 'case')!;
    expect(tc.attributes['test.case.result.status']).toBe('skipped');
    expect(tc.attributes['exception.type']).toBeUndefined();
  });
});

describe('onTestEnd — retries', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ignores a non-final failed attempt when more retries remain', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({ retries: 2 });
    reporter.onTestEnd(test, fakeResult({ status: 'failed', retry: 0, errors: [] }));
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const testSpans = spans.filter((s) => s.attributes['test.scope'] === 'case');
    expect(testSpans).toHaveLength(0);
  });

  it('emits a single span when the final retry passes (flaky)', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({ retries: 2, outcome: () => 'flaky' });
    reporter.onTestEnd(test, fakeResult({ status: 'failed', retry: 0, errors: [] }));
    reporter.onTestEnd(test, fakeResult({ status: 'passed', retry: 1 }));
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const testSpans = spans.filter((s) => s.attributes['test.scope'] === 'case');
    expect(testSpans).toHaveLength(1);
    expect(testSpans[0].attributes['test.case.result.status']).toBe('passed');
    expect(testSpans[0].attributes['cicd.test.retry_count']).toBe(1);

    const tc = reporter.getSession()!.testCases[0];
    expect(tc.flaky).toBe(true);
  });

  it('emits a single span when retries are exhausted and test still fails', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({ retries: 2, outcome: () => 'unexpected' });
    reporter.onTestEnd(test, fakeResult({ status: 'failed', retry: 0, errors: [] }));
    reporter.onTestEnd(test, fakeResult({ status: 'failed', retry: 1, errors: [] }));
    reporter.onTestEnd(test, fakeResult({ status: 'failed', retry: 2, errors: [] }));
    await reporter.onEnd({ status: 'failed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans();
    const testSpans = spans.filter((s) => s.attributes['test.scope'] === 'case');
    expect(testSpans).toHaveLength(1);
    expect(testSpans[0].attributes['test.case.result.status']).toBe('failed');
    expect(testSpans[0].attributes['cicd.test.retry_count']).toBe(2);
  });
});

describe('onTestEnd — multi-project', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits one span per project with cicd.test.project set', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());

    const chromium = fakeTest({
      title: 'same test',
      titlePath: ['chromium', '/root/tests/x.spec.ts', 'same test'],
    });
    const firefox = fakeTest({
      title: 'same test',
      titlePath: ['firefox', '/root/tests/x.spec.ts', 'same test'],
    });

    reporter.onTestEnd(chromium, fakeResult());
    reporter.onTestEnd(firefox, fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const spans = exporter.getFinishedSpans().filter((s) => s.attributes['test.scope'] === 'case');
    const projects = spans.map((s) => s.attributes['cicd.test.project']).sort();
    expect(projects).toEqual(['chromium', 'firefox']);
  });

  it('omits cicd.test.project when titlePath has empty project (ungrouped test)', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    const test = fakeTest({
      titlePath: ['', '/root/tests/x.spec.ts', 'my test'],
    });
    reporter.onTestEnd(test, fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const tc = exporter.getFinishedSpans().find((s) => s.attributes['test.scope'] === 'case')!;
    expect(tc.attributes['cicd.test.project']).toBeUndefined();
  });
});

describe('MERGIFY_TRACEPARENT propagation', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('makes the session span a child of the provided traceparent', async () => {
    vi.stubEnv('MERGIFY_TRACEPARENT', '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const session = exporter
      .getFinishedSpans()
      .find((s) => s.attributes['test.scope'] === 'session')!;
    expect(session.parentSpanContext?.traceId).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(session.parentSpanContext?.spanId).toBe('bbbbbbbbbbbbbbbb');
  });
});

describe('enablement rules', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not emit spans when outside CI without exporter or enable flag', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('CIRCLECI', '');
    vi.stubEnv('JENKINS_URL', '');
    vi.stubEnv('BUILDKITE', '');
    vi.stubEnv('PLAYWRIGHT_MERGIFY_ENABLE', '');

    const reporter = new MergifyReporter();

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    expect(reporter.getExporter()).toBeUndefined();
    expect(reporter.getSession()!.testCases).toHaveLength(1);
  });

  it('activates when PLAYWRIGHT_MERGIFY_ENABLE=true, even outside CI', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('PLAYWRIGHT_MERGIFY_ENABLE', 'true');

    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const testSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes['test.scope'] === 'case');
    expect(testSpans).toHaveLength(1);
  });
});

describe('resource attributes', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('attaches test framework + run id + ci provider + repo attrs on the resource', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });

    reporter.onBegin(fakeConfig(), fakeSuite());
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const span = exporter.getFinishedSpans()[0];
    const attrs = span.resource.attributes;
    expect(attrs['test.framework']).toBe('playwright');
    expect(attrs['test.framework.version']).toBeTruthy();
    expect(attrs['test.run.id']).toMatch(/^[0-9a-f]{16}$/);
    expect(attrs['cicd.provider.name']).toBe('github_actions');
    expect(attrs['vcs.repository.name']).toBe('test-owner/test-repo');
  });
});

describe('MergifyReporter V2 — quarantine', () => {
  let cacheRoot: string;
  let statePath: string;

  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'test-owner/test-repo');
    cacheRoot = mkdtempSync(join(tmpdir(), 'mergify-cache-'));
    statePath = stateFilePath(cacheRoot, 'abc123def456');
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        testRunId: 'abc123def456',
        createdAt: '2026-04-21T16:07:42Z',
        rootDir: '/root',
        quarantinedTests: ['tests/x.spec.ts > my test'],
      })
    );
    process.env.MERGIFY_TEST_RUN_ID = 'abc123def456';
    process.env.MERGIFY_STATE_FILE = statePath;
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete process.env.MERGIFY_TEST_RUN_ID;
    delete process.env.MERGIFY_STATE_FILE;
  });

  it('uses testRunId from MERGIFY_TEST_RUN_ID when set', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });
    expect(reporter.getSession()!.testRunId).toBe('abc123def456');
  });

  it('marks TestCaseResult.quarantined when the annotation is present', async () => {
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), fakeSuite());

    // Attach the annotation the fixture would have pushed.
    const test = fakeTest({
      titlePath: ['chromium', '/root/tests/x.spec.ts', 'my test'],
      location: { file: '/root/tests/x.spec.ts', line: 1, column: 1 },
      annotations: [{ type: 'mergify:quarantined' }],
    });

    reporter.onTestEnd(test, fakeResult({ status: 'failed', errors: [{ message: 'x' } as never] }));
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const session = reporter.getSession()!;
    expect(session.testCases[0].quarantined).toBe(true);
    const testSpan = exporter.getFinishedSpans().find((s) => s.attributes['test.scope'] === 'case');
    expect(testSpan!.attributes['cicd.test.quarantined']).toBe(true);
  });

  it('prints "fetched / caught / unused" summary in onEnd when fetched > 0', async () => {
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), fakeSuite());

    const test = fakeTest({
      titlePath: ['chromium', '/root/tests/x.spec.ts', 'my test'],
      location: { file: '/root/tests/x.spec.ts', line: 1, column: 1 },
      annotations: [{ type: 'mergify:quarantined' }],
    });
    reporter.onTestEnd(test, fakeResult({ status: 'failed', errors: [{ message: 'x' } as never] }));
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });

    const output = log.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('Quarantine report');
    expect(output).toContain('fetched: 1');
    expect(output).toContain('caught:  1');
    expect(output).toContain('    - tests/x.spec.ts > my test');
    expect(output).toContain('unused:  0');
  });

  it('omits the summary when no state file is present (V1 parity)', async () => {
    delete process.env.MERGIFY_TEST_RUN_ID;
    delete process.env.MERGIFY_STATE_FILE;
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exporter = new InMemorySpanExporter();
    const reporter = new MergifyReporter({ exporter });
    reporter.onBegin(fakeConfig(), fakeSuite());
    await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 });
    const output = log.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toContain('Quarantine report');
  });
});
