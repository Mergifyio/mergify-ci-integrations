import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { Reporter, TestCase, TestModule, Vitest } from 'vitest/node';
import { fetchQuarantineList } from './quarantine.js';
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
  private quarantineList: Set<string> = new Set();
  private quarantinedCaught: string[] = [];
  private _quarantinePromise: Promise<void> | undefined;

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

    // If quarantine list was provided via options (for testing), use it directly
    if (this.options.quarantineList) {
      this.quarantineList = new Set(this.options.quarantineList);
      this._configureRunner(vitest);
    } else if (this.tracing && token && repoName) {
      const attrs = this.tracing.resource.attributes;
      const branch = (attrs['vcs.ref.base.name'] ?? attrs['vcs.ref.head.name']) as
        | string
        | undefined;
      if (branch) {
        this._initQuarantine(vitest, { apiUrl, token, repoName, branch });
      }
    }
  }

  private _initQuarantine(
    vitest: Vitest,
    config: { apiUrl: string; token: string; repoName: string; branch: string }
  ): void {
    // Fetch is async but onInit is sync — we use a top-level await workaround
    // by storing the promise and resolving it in onTestRunStart
    const log = (msg: string) => vitest.logger.log(msg);
    this._quarantinePromise = fetchQuarantineList(config, log).then((list) => {
      this.quarantineList = list;
      if (list.size > 0) {
        this._configureRunner(vitest);
      }
    });
  }

  private _configureRunner(vitest: Vitest): void {
    // Provide quarantine list to workers via ProvidedContext
    vitest.provide('mergify:quarantine', [...this.quarantineList]);

    // Auto-configure the custom runner if not already set
    const dir = dirname(fileURLToPath(import.meta.url));
    const mergifyRunner = resolve(dir, 'runner.js');
    if (!vitest.config.runner) {
      vitest.config.runner = mergifyRunner;
    } else if (vitest.config.runner !== mergifyRunner) {
      vitest.logger.log(
        `[@mergifyio/vitest] Custom runner already configured (${vitest.config.runner}), quarantine may not work`
      );
    }
  }

  async onTestRunStart(): Promise<void> {
    // Wait for quarantine list to be fetched
    if (this._quarantinePromise) {
      await this._quarantinePromise;
      this._quarantinePromise = undefined;
    }

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
    const meta = testCase.meta() as Record<string, unknown>;
    const isQuarantined = meta.quarantined === true;

    if (isQuarantined) {
      this.quarantinedCaught.push(testCase.fullName);
    }

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
            'cicd.test.quarantined': isQuarantined,
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

    // Print quarantine summary
    if (this.quarantineList.size > 0) {
      const logger = this.vitest?.logger;
      logger?.log('');
      logger?.log('[@mergifyio/vitest] Quarantine report:');
      logger?.log(`  Quarantined tests fetched: ${this.quarantineList.size}`);

      if (this.quarantinedCaught.length > 0) {
        logger?.log(
          `  Quarantined tests caught (failures absorbed): ${this.quarantinedCaught.length}`
        );
        for (const name of this.quarantinedCaught) {
          logger?.log(`    - ${name}`);
        }
      }

      const unusedCount = this.quarantineList.size - this.quarantinedCaught.length;
      if (unusedCount > 0) {
        logger?.log(`  Unused quarantine entries: ${unusedCount}`);
      }
    }

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
