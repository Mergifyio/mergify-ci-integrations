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
import type { MergifyReporterOptions } from './types.js';
import { extractNamespace, mapStatus, projectNameFromTest } from './utils.js';

const DEFAULT_API_URL = 'https://api.mergify.com';

export class MergifyReporter implements Reporter {
  private options: MergifyReporterOptions;
  private session: TestRunSession | undefined;
  private tracing: TracingContext | null = null;
  private sessionSpan: Span | undefined;
  private config: FullConfig | undefined;

  constructor(options?: MergifyReporterOptions) {
    this.options = options ?? {};
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    this.config = config;

    const testRunId = generateTestRunId();
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
    const filepath = rootDir ? relative(rootDir, absoluteFilepath) : absoluteFilepath;

    const titlePath = test.titlePath();
    const namespace = extractNamespace(titlePath);
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
