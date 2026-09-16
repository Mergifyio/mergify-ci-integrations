import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { nativeTestCollectionFingerprint } from '@mergifyio/ci-core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The real runner against a fake Mergify: what Playwright does with
// `preprocess`, `skipSharding` and an empty suite cannot be stood in for by a
// stub `testRun`, and the verdict's wire shape is only proven by reading the
// request the bundled binding actually sends.

const fixtureRoot = resolve(import.meta.dirname, '..', 'fixtures');
const playwrightBin = resolve(
  import.meta.dirname,
  '..',
  '..',
  'node_modules',
  '.bin',
  'playwright'
);
const packageRoot = resolve(import.meta.dirname, '..', '..');

type Answer = Record<string, unknown>;

interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let requests: Request[];
let answer: Answer;

beforeAll(async () => {
  const build = spawnSync('pnpm', ['-F', '@mergifyio/playwright', 'build'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    throw new Error(`Package build failed:\n${build.stdout}\n${build.stderr}`);
  }

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', baseUrl);
      const raw = Buffer.concat(chunks);
      let body: unknown = null;
      if (url.pathname.endsWith('/test-session-verdicts')) {
        body = JSON.parse(gunzipSync(raw).toString('utf8'));
      }
      requests.push({
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        body,
      });
      res.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('/test-selection')) {
        res.end(JSON.stringify(answer));
      } else if (url.pathname.endsWith('/test-session-verdicts')) {
        res.end(JSON.stringify({ id: 1, outcome: 'recorded' }));
      } else {
        res.end('{}');
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  return () => new Promise<void>((done) => server.close(() => done()));
}, 60_000);

beforeEach(() => {
  requests = [];
  answer = { selection: 'full', reason: 'no_predecessor' };
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Asynchronous on purpose: the fake Mergify above answers from this process's
// event loop, which a `spawnSync` would block for the whole run -- every
// request would then time out and the verdict's retries would hang the test.
function run(args: string[] = [], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(
      playwrightBin,
      ['test', '--config', join(fixtureRoot, 'playwright.config.ts'), ...args],
      {
        cwd: fixtureRoot,
        env: {
          ...process.env,
          PW_FIXTURE_DIR: './tests-selection',
          PW_FIXTURE_PROJECTS: 'alpha,beta',
          PW_FIXTURE_RETRIES: '1',
          MERGIFY_TOKEN: 'test-token',
          MERGIFY_API_URL: baseUrl,
          MERGIFY_TEST_SELECTION_ENABLE: 'true',
          MERGIFY_TEST_JOB_NAME: 'e2e-1',
          CI: 'true',
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'acme/repo',
          GITHUB_EVENT_NAME: 'push',
          GITHUB_HEAD_REF: '',
          GITHUB_BASE_REF: '',
          GITHUB_SHA: 'cafecafe',
          GITHUB_WORKFLOW: 'CI',
          GITHUB_JOB: 'e2e',
          GITHUB_REF_NAME: 'mergify/merge-queue/main',
          GITHUB_RUN_ID: '42',
          GITHUB_RUN_ATTEMPT: '1',
          PLAYWRIGHT_MERGIFY_INCLUDE_PROJECT_IN_TEST_NAME: 'true',
          ...env,
        },
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

function selectionRequest(): Request {
  const request = requests.find((r) => r.path.endsWith('/test-selection'));
  if (!request)
    throw new Error(`no selection request among ${requests.map((r) => r.path).join(', ')}`);
  return request;
}

function verdict(): Record<string, unknown> {
  const request = requests.find((r) => r.path.endsWith('/test-session-verdicts'));
  if (!request) throw new Error(`no verdict among ${requests.map((r) => r.path).join(', ')}`);
  return request.body as Record<string, unknown>;
}

const ALPHA = [
  '[alpha] > a.spec.ts > a-passes',
  '[alpha] > a.spec.ts > a-fails',
  '[alpha] > a.spec.ts > a-flaky',
  '[alpha] > b.spec.ts > b-passes',
  '[alpha] > b.spec.ts > b-fails',
  '[alpha] > c.spec.ts > c-first',
  '[alpha] > c.spec.ts > c-second',
  '[alpha] > c.spec.ts > c-third',
];
const BETA = ALPHA.map((id) => id.replace('[alpha]', '[beta]'));

describe('integration: a first attempt', () => {
  it('asks with the whole collection, runs it, and files its verdict before the trace', async () => {
    const result = await run();

    expect(result.status).toBe(1);
    const asked = selectionRequest();
    expect(asked.query.get('job_name')).toBe('e2e-1');
    expect(asked.query.get('head_sha')).toBe('cafecafe');
    expect(asked.query.get('collection_fingerprint')).toBe(
      nativeTestCollectionFingerprint([...ALPHA, ...BETA])
    );

    const order = requests.map((r) => r.path.split('/').at(-1));
    expect(order.indexOf('test-session-verdicts')).toBeLessThan(order.indexOf('traces'));
    expect(verdict()).toMatchObject({
      test_run_id: expect.stringMatching(/^[0-9a-f]{16}$/),
      head_sha: 'cafecafe',
      head_branch: 'mergify/merge-queue/main',
      pipeline_name: 'CI',
      job_name: 'e2e-1',
      run_id: '42',
      run_attempt: 1,
      collection_fingerprint: nativeTestCollectionFingerprint([...ALPHA, ...BETA]),
      collection_count: 16,
      executed_count: 16,
      passed_count: 6,
      // The serial followers `c-second`/`c-third` never ran: Playwright
      // reports them skipped, the verdict lists them to be replayed.
      failed_count: 10,
      skipped_count: 0,
      failing_tests: [
        '[alpha] > a.spec.ts > a-fails',
        '[alpha] > b.spec.ts > b-fails',
        '[alpha] > c.spec.ts > c-first',
        '[alpha] > c.spec.ts > c-second',
        '[alpha] > c.spec.ts > c-third',
        '[beta] > a.spec.ts > a-fails',
        '[beta] > b.spec.ts > b-fails',
        '[beta] > c.spec.ts > c-first',
        '[beta] > c.spec.ts > c-second',
        '[beta] > c.spec.ts > c-third',
      ],
      quarantined_failing_tests: [],
      failing_tests_truncated: false,
      selection: { answer: 'full', reason: 'no_predecessor', kept_count: 16 },
    });
    expect(result.stderr).toContain('First attempt of this batch, so the full suite ran.');
  }, 60_000);
});

describe('integration: a sharded leg', () => {
  it('fingerprints and runs its own slice, on the leg itself', async () => {
    const result = await run(['--shard=1/2']);

    expect(result.status).toBe(1);
    // Sixteen tests over two legs: the three `[alpha]` files start inside leg
    // 1's eight-test range, so leg 1 is the whole of `alpha`.
    expect(selectionRequest().query.get('collection_fingerprint')).toBe(
      nativeTestCollectionFingerprint(ALPHA)
    );
    expect(verdict()).toMatchObject({
      collection_count: 8,
      executed_count: 8,
      failing_tests: [
        '[alpha] > a.spec.ts > a-fails',
        '[alpha] > b.spec.ts > b-fails',
        '[alpha] > c.spec.ts > c-first',
        '[alpha] > c.spec.ts > c-second',
        '[alpha] > c.spec.ts > c-third',
      ],
    });
    expect(result.stdout).not.toContain('[beta]');
  }, 60_000);

  it('replays exactly the served subset, with no second split', async () => {
    answer = {
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['[alpha] > a.spec.ts > a-fails', '[alpha] > b.spec.ts > b-fails'],
    };
    const result = await run(['--shard=1/2']);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/2 failed/);
    expect(result.stdout).not.toMatch(/passed/);
    expect(verdict()).toMatchObject({
      collection_count: 8,
      executed_count: 2,
      failed_count: 2,
      selection: { answer: 'subset', reason: 'queue_rerun', kept_count: 2 },
    });
    expect(result.stderr).toContain('Mergify re-executed only those 2 and skipped the 6');
  }, 60_000);

  it('replays a serial group whole, followers included', async () => {
    // What the previous attempt listed for `c.spec.ts`: the failure and the
    // two followers it kept from running. All three run again.
    answer = {
      selection: 'subset',
      reason: 'queue_rerun',
      tests: [
        '[alpha] > c.spec.ts > c-first',
        '[alpha] > c.spec.ts > c-second',
        '[alpha] > c.spec.ts > c-third',
      ],
    };
    const result = await run(['--shard=1/2']);

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/c-first/);
    expect(result.stdout).toMatch(/c-second/);
    expect(verdict()).toMatchObject({
      executed_count: 3,
      failed_count: 3,
      failing_tests: [
        '[alpha] > c.spec.ts > c-first',
        '[alpha] > c.spec.ts > c-second',
        '[alpha] > c.spec.ts > c-third',
      ],
      selection: { answer: 'subset', reason: 'queue_rerun', kept_count: 3 },
    });
  }, 60_000);

  it('runs nothing and exits green on an `empty` answer', async () => {
    answer = { selection: 'empty', reason: 'queue_rerun' };
    const result = await run(['--shard=2/2']);

    expect(result.status).toBe(0);
    expect(verdict()).toMatchObject({
      collection_count: 8,
      executed_count: 0,
      selection: { answer: 'empty', reason: 'queue_rerun', kept_count: 0 },
    });
    expect(result.stderr).toContain(
      'Mergify skipped them: the job is green, and no\ntest was executed.'
    );
  }, 60_000);
});

describe('integration: an unsharded job', () => {
  it('runs nothing and exits green on an `empty` answer', async () => {
    answer = { selection: 'empty', reason: 'queue_rerun' };
    const result = await run();

    expect(result.status).toBe(0);
    expect(verdict()).toMatchObject({ executed_count: 0, collection_count: 16 });
  }, 60_000);

  it('fails the run on a refusal, printing the server message, and still files its verdict', async () => {
    answer = {
      selection: 'refused',
      reason: 'ambiguous_test_sessions',
      message: 'Several runs of `e2e-1` reported the same tests to Mergify.',
    };
    const result = await run(['--shard=1/2']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Several runs of `e2e-1` reported the same tests to Mergify.');
    expect(result.stderr).toContain('its explanation is in the error\nabove.');
    expect(verdict()).toMatchObject({
      executed_count: 0,
      selection: { answer: 'refused', reason: 'ambiguous_test_sessions', kept_count: 0 },
    });
  }, 60_000);

  it('runs everything and says so when the subset names a test it did not collect', async () => {
    answer = {
      selection: 'subset',
      reason: 'queue_rerun',
      tests: ['[alpha] > a.spec.ts > a-fails', '[alpha] > a.spec.ts > renamed'],
    };
    const result = await run();

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/6 failed/);
    expect(verdict()).toMatchObject({
      executed_count: 16,
      selection: {
        answer: 'subset',
        reason: 'queue_rerun',
        kept_count: 16,
        not_applied_reason: 'subset_partly_absent_from_collection',
      },
    });
    expect(result.stderr).toContain(
      "Mergify's answer didn't match the tests this run collected, so the full suite\nran."
    );
  }, 60_000);
});
