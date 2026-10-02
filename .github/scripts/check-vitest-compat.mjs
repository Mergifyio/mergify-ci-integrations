#!/usr/bin/env node
// Run the packed @mergifyio/vitest against one Vitest version in one config
// shape, the way a user would, and prove its three run-time features apply:
// a quarantined failure is absorbed, a new test that fails then passes is
// rerun and flagged flaky, and a served selection skips what it leaves out.
//
// Why a matrix at all: the features ride on Vitest's runner, and where that
// runner comes from changes with the shape -- browser mode builds its own,
// `projects` configure each project apart, the Cloudflare Workers pool runs
// tests in workerd -- and with the version: the base class moved from
// `vitest/runners` to `vitest` in 4.1 and 5.0 removed the old subpath. Each
// of those silently turned the features off, or broke the run, while every
// unit test passed against the one Vitest this workspace pins.
//
// Browser mode drives a real headless Chromium through Playwright, installed
// here (with its system dependencies under CI). Playwright and the Workers pool
// are pinned so a cell cannot turn red on a release of theirs;
// PLAYWRIGHT_VERSION overrides the former, for a browser already on disk.
//
// Usage: check-vitest-compat.mjs <dist-dir> <version> <vitest-range> <shape>
//   shape: node | browser | projects | cloudflare
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [distArg, version, vitestRange, shape] = process.argv.slice(2);
if (
  !distArg ||
  !version ||
  !vitestRange ||
  !['node', 'browser', 'projects', 'cloudflare'].includes(shape)
) {
  console.error(
    'usage: check-vitest-compat.mjs <dist-dir> <version> <vitest-range> <node|browser|projects|cloudflare>'
  );
  process.exit(2);
}
const distDir = resolve(distArg);

const PLATFORMS = {
  'linux-x64': 'linux-x64-gnu',
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
};
const platform = PLATFORMS[`${process.platform}-${process.arch}`];
if (!platform) {
  console.error(`::error::no napi target mapped for ${process.platform}-${process.arch}`);
  process.exit(1);
}
const tgz = (name) => {
  const p = join(distDir, `mergifyio-${name}-${version}.tgz`);
  if (!existsSync(p)) {
    console.error(`::error::missing tarball ${p}`);
    process.exit(1);
  }
  return p.replaceAll('\\', '/');
};

const work = join(tmpdir(), `vitest-compat-${shape}-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'tests'), { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, encoding: 'utf8', stdio: 'pipe' });

// --- a consumer project -------------------------------------------------------
writeFileSync(
  join(work, 'package.json'),
  `${JSON.stringify({ name: 'vitest-compat', private: true, type: 'module' }, null, 2)}\n`
);
const internal = ['ci-core', 'ci-native', `ci-native-${platform}`];
// Vite 5 to 7 install esbuild's binary, and the Workers pool workerd's, from
// build scripts pnpm refuses unless they are allowed. Other scripts (msw's, in
// @vitest/browser 3.0) are not needed and are skipped rather than fatal.
writeFileSync(
  join(work, 'pnpm-workspace.yaml'),
  `strictDepBuilds: false\nallowBuilds:\n  esbuild: true\n  workerd: true\noverrides:\n${internal
    .map((name) => `  "@mergifyio/${name}": "file:${tgz(name)}"\n`)
    .join('')}`
);
run('pnpm', ['add', `vitest@${vitestRange}`]);
const vitestVersion = JSON.parse(
  readFileSync(join(work, 'node_modules/vitest/package.json'), 'utf8')
).version;
const [major, minor] = vitestVersion.split('.').map(Number);
const extra = [];
if (shape === 'browser' || shape === 'projects') {
  // Vitest 4 split the Playwright provider out of @vitest/browser.
  extra.push(
    major >= 4 ? `@vitest/browser-playwright@${vitestVersion}` : `@vitest/browser@${vitestVersion}`,
    `playwright@${process.env.PLAYWRIGHT_VERSION ?? '1.62.1'}`
  );
}
if (shape === 'cloudflare') {
  extra.push(
    '@cloudflare/vitest-pool-workers@0.16.3',
    `@vitest/runner@${vitestVersion}`,
    `@vitest/snapshot@${vitestVersion}`
  );
}
run('pnpm', ['add', ...internal.map(tgz), tgz('vitest'), ...extra]);
if (shape === 'browser' || shape === 'projects') {
  run('pnpm', [
    'exec',
    'playwright',
    'install',
    ...(process.env.CI ? ['--with-deps'] : []),
    'chromium',
  ]);
}
console.log(`vitest ${vitestVersion}, shape ${shape}, work dir ${work}`);

// --- fixtures -----------------------------------------------------------------
writeFileSync(
  join(work, 'tests/quarantine.test.js'),
  `import { expect, it } from 'vitest';
it('quarantined failure', () => { expect(1).toBe(2); });
it('passing', () => {});
`
);
writeFileSync(
  join(work, 'tests/flaky.test.js'),
  `import { it } from 'vitest';
let calls = 0;
it('new flaky', () => { calls++; if (calls === 1) throw new Error('first try fails'); });
`
);
writeFileSync(
  join(work, 'tests/selection.test.js'),
  `import { expect, it } from 'vitest';
it('served', () => {});
it('left out', () => { expect(1).toBe(2); });
`
);
// Records each test's final state and the meta the features leave, where the
// check can read it after the run.
writeFileSync(
  join(work, 'probe.mjs'),
  `import { writeFileSync } from 'node:fs';
export default class Probe {
  onTestRunEnd(modules) {
    const tests = [];
    for (const m of modules) for (const t of m.children.allTests()) {
      tests.push({ project: m.project.name, name: t.name, state: t.result().state, meta: t.meta() });
    }
    writeFileSync(process.env.PROBE_OUT, JSON.stringify(tests));
  }
}
`
);
const browser =
  major >= 4
    ? `{ enabled: true, headless: true, provider: (await import('@vitest/browser-playwright')).playwright(), instances: [{ browser: 'chromium' }] }`
    : `{ enabled: true, headless: true, provider: 'playwright', instances: [{ browser: 'chromium' }] }`;
const multi = major > 3 || (major === 3 && minor >= 2) ? 'projects' : 'workspace';
const shapes = {
  node: (include) => `{ include: ${include} }`,
  browser: (include) => `{ include: ${include}, browser: ${browser} }`,
  projects: (include) =>
    `{ ${multi}: [{ test: { name: 'node', include: ${include} } }, { test: { name: 'web', include: ${include}, browser: ${browser} } }] }`,
  cloudflare: (include) => `{ include: ${include} }`,
};

const FLAKY_CONTEXT = {
  budget_ratio_for_new_tests: 1,
  budget_ratio_for_unhealthy_tests: 1,
  existing_test_names: ['quarantined failure', 'passing', 'served', 'left out'],
  existing_tests_mean_duration_ms: 10,
  unhealthy_test_names: [],
  budget_ratio_for_test_retries: 0,
  flaky_test_names: [],
  broken_test_names: [],
  max_test_execution_count: 5,
  max_test_name_length: 255,
  min_budget_duration_ms: 10000,
  min_test_execution_count: 2,
};

function vitestRun(label, include, options) {
  const config = join(work, `vitest.${label}.config.mjs`);
  writeFileSync(
    config,
    `import { defineConfig } from 'vitest/config';
import { MergifyReporter } from '@mergifyio/vitest';
import Probe from './probe.mjs';
${shape === 'cloudflare' ? "import { cloudflareTest } from '@cloudflare/vitest-pool-workers';" : ''}
export default defineConfig({
  ${shape === 'cloudflare' ? "plugins: [cloudflareTest({ miniflare: { compatibilityDate: '2026-05-01', compatibilityFlags: ['nodejs_compat'] } })]," : ''}
  test: {
    watch: false,
    reporters: ['default', new MergifyReporter(${JSON.stringify(options)}), new Probe()],
    ...${shapes[shape](JSON.stringify(include))},
  },
});
`
  );
  const probeOut = join(work, `probe.${label}.json`);
  const bin = join(work, 'node_modules/vitest/vitest.mjs');
  // Never watch, and never hang: a run that does not finish is a failure.
  const result = spawnSync(process.execPath, [bin, 'run', '--config', config], {
    cwd: work,
    encoding: 'utf8',
    timeout: 240_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', PROBE_OUT: probeOut },
  });
  const output = `${result.stdout}${result.stderr}`;
  const tests = existsSync(probeOut) ? JSON.parse(readFileSync(probeOut, 'utf8')) : [];
  // A run that hung, crashed before reporting, or recorded no test proves
  // nothing about the features, whatever the checks below would say.
  if (result.signal || tests.length === 0) {
    problems.push(
      `${label}: the run did not finish with results (signal ${result.signal}, ${tests.length} tests)\n${output}`
    );
  }
  return { status: result.status, signal: result.signal, output, tests };
}

const problems = [];
const expect = (label, ok, what, detail) => {
  if (ok) console.log(`  ok  ${label}: ${what}`);
  else problems.push(`${label}: ${what}\n${detail}`);
};
const hasBrowserProject = shape === 'browser' || shape === 'projects';

// --- quarantine: the failure is absorbed and the run is green ------------------
{
  const r = vitestRun('quarantine', ['tests/quarantine.test.js'], {
    quarantineList: ['quarantined failure'],
  });
  const quarantined = r.tests.filter((t) => t.name === 'quarantined failure');
  expect('quarantine', r.status === 0, 'the run passes', r.output);
  expect(
    'quarantine',
    quarantined.length > 0 &&
      quarantined.every((t) => t.state === 'passed' && t.meta.quarantined === true),
    `the failure is absorbed in every project (${quarantined.map((t) => `${t.project || 'root'}=${t.state}`).join(', ')})`,
    r.output
  );
}

// --- flaky detection: a new test that fails then passes is rerun and flagged ---
{
  const r = vitestRun('flaky', ['tests/flaky.test.js'], {
    flakyContext: FLAKY_CONTEXT,
    flakyMode: 'new',
  });
  for (const t of r.tests) {
    const where = t.project || 'root';
    // Vitest names a browser project after its instance: `web (chromium)`.
    const inBrowser = shape === 'browser' || (shape === 'projects' && t.project !== 'node');
    if (inBrowser || shape === 'cloudflare') {
      // Its budget needs the native binding, which neither a page nor workerd
      // can load: not rerun, and the run says so.
      expect('flaky', t.meta.flakyDetection !== true, `${where}: not rerun`, JSON.stringify(t));
    } else {
      expect(
        'flaky',
        t.meta.flakyDetection === true && t.meta.rerunCount > 0 && t.meta.flaky === true,
        `${where}: rerun and flagged flaky`,
        `${JSON.stringify(t)}\n${r.output}`
      );
    }
  }
  if (hasBrowserProject) {
    expect(
      'flaky',
      r.output.includes('does not run in browser projects yet'),
      'the run says browser projects were not checked',
      r.output
    );
  }
  if (shape === 'cloudflare') {
    expect(
      'flaky',
      r.output.includes('native binding cannot load'),
      'the run says the Workers pool was not checked',
      r.output
    );
  }
}

// --- test selection: what the subset leaves out is not run ---------------------
{
  const r = vitestRun('selection', ['tests/selection.test.js'], { testSelection: ['served'] });
  expect('selection', r.status === 0, 'the run passes without the left-out failure', r.output);
  const leftOut = r.tests.filter((t) => t.name === 'left out');
  // `skipped`, not merely "not run": Vitest's own summary counts from this
  // state, and a `pending` test is in its total without being listed anywhere.
  // Vitest 3.0 sends nothing back for a test skipped at run time, so there it
  // stays `pending`; 3.1 started reporting it.
  const reportsSkip = major > 3 || minor >= 1;
  expect(
    'selection',
    leftOut.length > 0 &&
      leftOut.every((t) => (reportsSkip ? t.state === 'skipped' : t.state === 'pending')),
    reportsSkip
      ? 'the left-out test did not run, and Vitest reports it skipped'
      : 'the left-out test did not run',
    JSON.stringify(leftOut)
  );
}

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });
console.log(`ok: vitest ${vitestVersion}, ${shape}`);
