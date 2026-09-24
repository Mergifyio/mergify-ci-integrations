#!/usr/bin/env node
// Install the packed tarballs the way a user would, on this runner's platform,
// and prove the result actually loads.
//
// No local registry is involved and none is needed: overrides point the
// packages' links to each other (ci-core -> ci-native -> the platform binary)
// at the packed files, since the release version is not on the registry yet.
//
// The peer is pinned deliberately. Left to itself pnpm resolves `vitest` to
// whatever `>=3.0.0` currently allows, which is a major nobody has tested
// against; that range is its own open question and not something this check
// should silently depend on.
//
// Usage: check-ts-install.mjs <dist-dir> <version> [vitest-version]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const [distArg, version, vitestVersion = '4.1.10'] = process.argv.slice(2);
if (!distArg || !version) {
  console.error('usage: check-ts-install.mjs <dist-dir> <version> [vitest-version]');
  process.exit(2);
}
// npm runs in a scratch directory below, so a relative path would resolve
// there -- and npm reads an unresolvable `dist/x.tgz` as a GitHub shorthand.
const distDir = resolve(distArg);

// napi's target naming, for the one platform this runner can actually execute.
const PLATFORMS = {
  'linux-x64': 'linux-x64-gnu',
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'win32-x64': 'win32-x64-msvc',
};
const key = `${process.platform}-${process.arch}`;
const platform = PLATFORMS[key];
if (!platform) {
  console.error(`::error::no napi target mapped for ${key}`);
  process.exit(1);
}

const tgz = (name) => {
  const p = join(distDir, `mergifyio-${name}-${version}.tgz`);
  if (!existsSync(p)) {
    console.error(`::error::missing tarball ${p}`);
    process.exit(1);
  }
  return p;
};

const work = join(tmpdir(), `ts-install-check-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

writeFileSync(
  join(work, 'package.json'),
  `${JSON.stringify(
    {
      name: 'install-check',
      private: true,
      version: '1.0.0',
      devDependencies: { vitest: vitestVersion },
    },
    null,
    2
  )}\n`
);

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: work, encoding: 'utf8', stdio: 'pipe', ...opts });

console.log(`platform: ${key} -> @mergifyio/ci-native-${platform}`);
console.log('installing the packed tarballs...');
// pnpm, like the rest of this repository. The packages depend on each other at
// the release version, which is not on the registry until this draft is
// published, so the overrides point those links at the packed files: every
// @mergifyio package below resolves to a tarball or fails, never to a
// registry copy. The other platforms' binaries are optional and absent.
const internal = ['ci-core', 'ci-native', `ci-native-${platform}`];
writeFileSync(
  join(work, 'pnpm-workspace.yaml'),
  `overrides:\n${internal
    .map((name) => `  "@mergifyio/${name}": "file:${tgz(name).replaceAll('\\', '/')}"\n`)
    .join('')}`
);
// Windows ships pnpm behind a .cmd shim, and Node refuses to spawn a .cmd
// without a shell (EINVAL since CVE-2024-27980).
const isWindows = process.platform === 'win32';
const pnpm = (args) => run('pnpm', args, { shell: isWindows });
console.log(`node ${process.version}, pnpm ${pnpm(['--version']).trim()}`);
pnpm([
  'add',
  ...[`ci-native-${platform}`, 'ci-native', 'ci-core', 'vitest', 'playwright'].map((name) =>
    tgz(name).replaceAll('\\', '/')
  ),
]);

const problems = [];
const manifest = (p) => JSON.parse(readFileSync(join(work, 'node_modules', p, 'package.json'), 'utf8'));

// --- every package resolved to the packed copy, not something off the registry
for (const name of [
  '@mergifyio/ci-core',
  '@mergifyio/ci-native',
  '@mergifyio/vitest',
  '@mergifyio/playwright',
  `@mergifyio/ci-native-${platform}`,
]) {
  try {
    const got = manifest(name).version;
    if (got !== version) problems.push(`${name} installed at ${got}, expected ${version}`);
    else console.log(`  ${name}@${got}`);
  } catch {
    problems.push(`${name} did not install`);
  }
}

// --- the loader finds its binary and the Rust core answers -----------------
const probe = join(work, 'probe.cjs');
writeFileSync(
  probe,
  `const n = require('@mergifyio/ci-native');
   const a = n.detectAttributes();
   if (typeof a !== 'object' || a === null) throw new Error('detectAttributes returned ' + typeof a);
   console.log('  detectAttributes() ok');
  `
);
try {
  process.stdout.write(run('node', [probe]));
} catch (e) {
  problems.push(`native binding failed to load: ${e.stderr || e.message}`);
}

// --- both module formats load ----------------------------------------------
for (const [label, source] of [
  ['require()', "const m = require('@mergifyio/vitest'); if (!m.MergifyReporter) throw new Error('no MergifyReporter');"],
  ['import()', "const m = await import('@mergifyio/vitest'); if (!m.MergifyReporter) throw new Error('no MergifyReporter');"],
]) {
  const file = join(work, label === 'require()' ? 'load.cjs' : 'load.mjs');
  writeFileSync(file, source);
  try {
    run('node', [file]);
    console.log(`  ${label} ok`);
  } catch (e) {
    problems.push(`${label} failed: ${e.stderr || e.message}`);
  }
}

// --- the runner path the reporter computes points at a packed file ---------
// tests/runner-path.test.ts asserts this against ../src, which proves the
// computation. Doing it against node_modules also proves the file survived
// packing -- and this is the exact defect that shipped in 0.1.1 through 0.3.4,
// where a hardcoded `runner.js` matched no emitted file. vitest does not fail
// loudly on an unresolvable runner, so nothing downstream would notice.
const runnerProbe = join(work, 'runner-probe.mjs');
writeFileSync(
  runnerProbe,
  `import { existsSync } from 'node:fs';
   const { MergifyReporter } = await import('@mergifyio/vitest');
   const vitest = { version: '${vitestVersion}', config: {}, logger: { log: () => {} }, provide: () => {} };
   new MergifyReporter({ quarantineList: ['suite > quarantined'] }).onInit(vitest);
   const runner = vitest.config.runner;
   if (!runner) { console.error('reporter configured no runner'); process.exit(1); }
   if (!existsSync(runner)) { console.error('runner path does not exist: ' + runner); process.exit(1); }
   console.log('  runner resolves: ' + runner.split(/[\\\\/]/).pop());
  `
);
try {
  process.stdout.write(run('node', [runnerProbe]));
} catch (e) {
  problems.push(`runner path check failed: ${e.stdout || ''}${e.stderr || e.message}`);
}

rmSync(work, { recursive: true, force: true });

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(`ok: packed packages install and load on ${key}`);
