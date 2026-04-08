import { type Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { Reporter, TestCase, TestModule, Vitest } from 'vitest/node';
import type { TracingContext } from './tracing.js';
import { createTracing } from './tracing.js';
import type { MergifyReporterOptions, TestCaseResult, TestRunSession } from './types.js';
import { extractNamespace, generateTestRunId, getRepositoryNameFromUrl, git } from './utils.js';

const DEFAULT_API_URL = 'https://api.mergify.com';

function getRepoName(): string | undefined {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;

  if (process.env.GIT_URL) {
    return getRepositoryNameFromUrl(process.env.GIT_URL) ?? undefined;
  }

  const remoteUrl = git('config', '--get', 'remote.origin.url');
  if (remoteUrl) return getRepositoryNameFromUrl(remoteUrl) ?? undefined;

  return undefined;
}

export class MergifyReporter implements Reporter {
  private vitest: Vitest | undefined;
  private session: TestRunSession | undefined;
  private tracing: TracingContext | null = null;
  private sessionSpan: Span | undefined;
  private options: MergifyReporterOptions;
  private _testRunId: string | undefined;

  constructor(options?: MergifyReporterOptions) {
    this.options = options ?? {};
  }

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
    vitest.config.includeTaskLocation = true;

    const testRunId = generateTestRunId();
    const token = this.options.token ?? process.env.MERGIFY_TOKEN;
    const apiUrl = this.options.apiUrl ?? process.env.MERGIFY_API_URL ?? DEFAULT_API_URL;
    const repoName = getRepoName();

    this.tracing = createTracing({
      token,
      repoName,
      apiUrl,
      testRunId,
      vitestVersion: vitest.version,
      exporter: this.options.exporter,
    });

    if (!this.tracing && (process.env.CI || process.env.VITEST_MERGIFY_ENABLE)) {
      if (!token) {
        vitest.logger.log(
          '[@mergifyio/vitest] MERGIFY_TOKEN not set, skipping CI Insights reporting'
        );
      } else if (!repoName) {
        vitest.logger.log(
          '[@mergifyio/vitest] Could not detect repository name, skipping CI Insights reporting'
        );
      }
    }

    this._testRunId = testRunId;
  }

  onTestRunStart(): void {
    const testRunId = this._testRunId ?? generateTestRunId();

    this.session = {
      testRunId,
      scope: 'session',
      startTime: Date.now(),
      status: 'passed',
      testCases: [],
    };

    if (this.tracing) {
      let parentContext = context.active();

      const traceparent = process.env.MERGIFY_TRACEPARENT;
      if (traceparent) {
        const carrier = { traceparent };
        const propagator = new W3CTraceContextPropagator();
        parentContext = propagator.extract(context.active(), carrier, {
          get(c: Record<string, string>, key: string) {
            return c[key];
          },
          keys(c: Record<string, string>) {
            return Object.keys(c);
          },
        });
      }

      this.sessionSpan = this.tracing.tracer.startSpan(
        'vitest session start',
        { attributes: { 'test.scope': 'session' } },
        parentContext
      );
    }
  }

  onTestCaseResult(testCase: TestCase): void {
    if (!this.session) return;

    const result = testCase.result();
    if (result.state === 'pending') return;

    const diagnostic = testCase.diagnostic();
    const module = testCase.module;

    const testCaseResult: TestCaseResult = {
      filepath: module.relativeModuleId,
      absoluteFilepath: module.moduleId,
      function: testCase.name,
      lineno: testCase.location?.line ?? 0,
      namespace: extractNamespace(testCase.fullName, testCase.name),
      scope: 'case',
      status: result.state,
      duration: diagnostic?.duration ?? 0,
      startTime: diagnostic?.startTime ?? 0,
      retryCount: diagnostic?.retryCount ?? 0,
      flaky: diagnostic?.flaky ?? false,
    };

    if (result.state === 'failed' && result.errors?.length) {
      const firstError = result.errors[0];
      testCaseResult.error = {
        type: firstError.name ?? 'Error',
        message: firstError.message ?? '',
        stacktrace: firstError.stack ?? '',
      };
    }

    this.session.testCases.push(testCaseResult);

    // Create OTel span for this test case
    if (this.tracing && this.sessionSpan) {
      const parentCtx = trace.setSpan(context.active(), this.sessionSpan);
      const startTimeMs = diagnostic?.startTime ?? Date.now();
      const endTimeMs = startTimeMs + (diagnostic?.duration ?? 0);

      const span = this.tracing.tracer.startSpan(
        testCase.fullName,
        {
          attributes: {
            'code.filepath': testCaseResult.filepath,
            'code.function': testCaseResult.function,
            'code.lineno': testCaseResult.lineno,
            'code.namespace': testCaseResult.namespace,
            'code.file.path': testCaseResult.absoluteFilepath,
            'code.line.number': testCaseResult.lineno,
            'test.scope': 'case',
            'test.case.result.status': testCaseResult.status,
          },
          startTime: startTimeMs,
        },
        parentCtx
      );

      if (testCaseResult.error) {
        span.setAttributes({
          'exception.type': testCaseResult.error.type,
          'exception.message': testCaseResult.error.message,
          'exception.stacktrace': testCaseResult.error.stacktrace,
        });
      }

      if (result.state === 'failed') {
        span.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end(endTimeMs);
    }
  }

  async onTestRunEnd(
    _testModules: ReadonlyArray<TestModule>,
    _unhandledErrors: ReadonlyArray<unknown>,
    reason: 'passed' | 'failed' | 'interrupted'
  ): Promise<void> {
    if (!this.session) return;

    this.session.endTime = Date.now();
    this.session.status = reason;

    if (this.sessionSpan) {
      if (reason === 'failed') {
        this.sessionSpan.setStatus({ code: SpanStatusCode.ERROR });
      } else {
        this.sessionSpan.setStatus({ code: SpanStatusCode.OK });
      }
      this.sessionSpan.end();
    }

    if (this.tracing) {
      try {
        await this.tracing.tracerProvider.forceFlush();
      } catch (err) {
        this.vitest?.logger.log(`[@mergifyio/vitest] Failed to flush spans: ${err}`);
      }
      if (this.tracing.ownsExporter) {
        try {
          await this.tracing.tracerProvider.shutdown();
        } catch {
          // ignore shutdown errors
        }
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
