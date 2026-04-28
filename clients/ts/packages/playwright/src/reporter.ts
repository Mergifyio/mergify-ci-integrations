import { relative } from 'node:path';
import {
  createTracing,
  emitTestCaseSpan,
  endSessionSpan,
  envToBool,
  generateTestRunId,
  getRepoName,
  isInCI,
  startSessionSpan,
  type TestCaseResult,
  type TestRunSession,
  type TracingContext,
} from '@mergifyio/ci-core';
import type { Span } from '@opentelemetry/api';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import * as playwrightResource from './resources/playwright.js';
import { readStateFile } from './state-file.js';
import type { MergifyReporterOptions } from './types.js';
import {
  buildQuarantineKey,
  extractNamespace,
  mapStatus,
  projectNameFromTest,
  toPosix,
} from './utils.js';

const DEFAULT_API_URL = 'https://api.mergify.com';

export class MergifyReporter implements Reporter {
  private options: MergifyReporterOptions;
  private session: TestRunSession | undefined;
  private tracing: TracingContext | null = null;
  private sessionSpan: Span | undefined;
  private config: FullConfig | undefined;
  private quarantineFetchedCount = 0;
  private quarantineFetchedNames: string[] = [];
  private quarantinedCaught: string[] = [];

  constructor(options?: MergifyReporterOptions) {
    this.options = options ?? {};
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    this.config = config;

    const envId = process.env.MERGIFY_TEST_RUN_ID;
    const testRunId = envId ?? generateTestRunId();
    const token = this.options.token ?? process.env.MERGIFY_TOKEN;
    const apiUrl = this.options.apiUrl ?? process.env.MERGIFY_API_URL ?? DEFAULT_API_URL;
    const repoName = getRepoName();

    const enabled =
      isInCI() ||
      envToBool(process.env.PLAYWRIGHT_MERGIFY_ENABLE, false) ||
      !!this.options.exporter;

    if (enabled) {
      this.tracing = createTracing({
        token,
        repoName,
        apiUrl,
        testRunId,
        frameworkAttributes: playwrightResource.detect(),
        tracerName: '@mergifyio/playwright',
        exporter: this.options.exporter,
      });
    }

    if (!this.tracing && enabled) {
      if (!token) {
        process.stderr.write(
          '[@mergifyio/playwright] MERGIFY_TOKEN not set, skipping CI Insights reporting\n'
        );
      } else if (!repoName) {
        process.stderr.write(
          '[@mergifyio/playwright] Could not detect repository name, skipping CI Insights reporting\n'
        );
      }
    }

    const statePath = process.env.MERGIFY_STATE_FILE;
    if (statePath) {
      const state = readStateFile(statePath);
      if (state) {
        this.quarantineFetchedCount = state.quarantinedTests.length;
        this.quarantineFetchedNames = state.quarantinedTests;
      }
    }

    this.session = {
      testRunId,
      scope: 'session',
      startTime: Date.now(),
      status: 'passed',
      testCases: [],
    };

    if (this.tracing) {
      this.sessionSpan = startSessionSpan(this.tracing, 'playwright session start');
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.session) return;

    const retries = test.retries ?? 0;
    const isFinal =
      result.status === 'passed' || result.status === 'skipped' || result.retry >= retries;

    if (!isFinal) return;

    const rootDir = this.config?.rootDir ?? '';
    const absoluteFilepath = test.location?.file ?? '';
    const filepath = toPosix(rootDir ? relative(rootDir, absoluteFilepath) : absoluteFilepath);

    const titlePath = test.titlePath();
    const namespace = extractNamespace(filepath, titlePath);
    const project = projectNameFromTest(test);

    const testCaseResult: TestCaseResult = {
      filepath,
      absoluteFilepath,
      function: test.title,
      lineno: test.location?.line ?? 0,
      namespace,
      scope: 'case',
      status: mapStatus(result.status),
      duration: result.duration,
      startTime: result.startTime.getTime(),
      retryCount: result.retry,
      flaky: test.outcome() === 'flaky',
    };

    if (project !== undefined) {
      testCaseResult.project = project;
    }

    if (result.status !== 'passed' && result.status !== 'skipped' && result.errors.length > 0) {
      const firstError = result.errors[0];
      const type =
        typeof firstError.value === 'string'
          ? (firstError.value.split(':')[0] ?? 'Error')
          : 'Error';
      testCaseResult.error = {
        type,
        message: firstError.message ?? '',
        stacktrace: firstError.stack ?? '',
      };
    }

    const isQuarantined = test.annotations.some((a) => a.type === 'mergify:quarantined');
    if (isQuarantined) {
      testCaseResult.quarantined = true;
      this.quarantinedCaught.push(buildQuarantineKey(filepath, titlePath, test.title));
    }

    this.session.testCases.push(testCaseResult);

    if (this.tracing && this.sessionSpan) {
      emitTestCaseSpan(this.tracing.tracer, this.sessionSpan, testCaseResult);
    }
  }

  async onEnd(result: FullResult): Promise<void> {
    if (!this.session) return;

    const reason: 'passed' | 'failed' | 'interrupted' =
      result.status === 'passed'
        ? 'passed'
        : result.status === 'interrupted'
          ? 'interrupted'
          : 'failed';

    this.session.endTime = Date.now();
    this.session.status = reason;

    if (this.quarantineFetchedCount > 0) {
      const unused = this.quarantineFetchedCount - this.quarantinedCaught.length;
      process.stderr.write('[@mergifyio/playwright] Quarantine report:\n');
      process.stderr.write(`  fetched: ${this.quarantineFetchedCount}\n`);
      process.stderr.write(`  caught:  ${this.quarantinedCaught.length}\n`);
      for (const name of this.quarantinedCaught) {
        process.stderr.write(`    - ${name}\n`);
      }
      process.stderr.write(`  unused:  ${unused}\n`);
      if (unused > 0) {
        const caughtSet = new Set(this.quarantinedCaught);
        const unusedNames = this.quarantineFetchedNames.filter((n) => !caughtSet.has(n));
        for (const name of unusedNames) {
          process.stderr.write(`    - ${name}\n`);
        }
      }
    }

    if (this.tracing && this.sessionSpan) {
      try {
        await endSessionSpan(this.tracing, this.sessionSpan, reason);
      } catch (err) {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`[@mergifyio/playwright] Failed to flush spans: ${detail}\n`);
      }
    }
  }

  getSession(): TestRunSession | undefined {
    return this.session;
  }

  getExporter() {
    return this.tracing?.exporter;
  }
}

export default MergifyReporter;
