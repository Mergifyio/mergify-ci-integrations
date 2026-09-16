import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { nativeTestCollectionFingerprint } from '@mergifyio/ci-core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The real runner against a fake Mergify: what Playwright does with
// `preprocess`, `skipSharding` and an empty suite cannot be stood in for by a
// stub `testRun`.

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
    req.on('data', () => {});
    req.on('end', () => {
      const url = new URL(req.url ?? '/', baseUrl);
      requests.push({
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
      });
      res.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('/test-selection')) {
        res.end(JSON.stringify(answer));
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
// request would then time out and the upload's retries would hang the test.
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
  it('asks with the whole collection and runs it', async () => {
    const result = await run();

    expect(result.status).toBe(1);
    const asked = selectionRequest();
    expect(asked.query.get('job_name')).toBe('e2e-1');
    expect(asked.query.get('head_sha')).toBe('cafecafe');
    expect(asked.query.get('collection_fingerprint')).toBe(
      nativeTestCollectionFingerprint([...ALPHA, ...BETA])
    );

    expect(result.stdout).toMatch(/6 failed/);
    expect(result.stdout).toMatch(/2 flaky/);
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
  }, 60_000);

  it('runs nothing and exits green on an `empty` answer', async () => {
    answer = { selection: 'empty', reason: 'queue_rerun' };
    const result = await run(['--shard=2/2']);

    expect(result.status).toBe(0);
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
    expect(result.stdout).not.toMatch(/passed|failed/);
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
    expect(result.stderr).toContain(
      "Mergify's answer didn't match the tests this run collected, so the full suite\nran."
    );
  }, 60_000);
});
