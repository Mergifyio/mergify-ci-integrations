#!/usr/bin/env node
// Assert the contents of the packed npm tarballs, before they become a draft
// release and therefore before they can be published.
//
// This runs against the tarballs the release itself packs -- never the working
// tree -- for the same reason ci.yml's rspec-gem job builds a staged gem: a
// packaging defect is invisible from the source tree. `pnpm pack` exits 0
// whether or not a LICENSE is beside the manifest, whether or not the `files`
// array still names anything real, and (verified) whether or not a napi
// platform package actually contains its .node binary. That last one is how
// ts-v0.3.6 shipped a Windows package with no Windows binary in it.
//
// Usage: check-ts-packages.mjs <dist-dir> <expected-version>
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [distDir, expectedVersion] = process.argv.slice(2);
if (!distDir || !expectedVersion) {
  console.error('usage: check-ts-packages.mjs <dist-dir> <expected-version>');
  process.exit(2);
}

const PLATFORM_PREFIX = '@mergifyio/ci-native-';
const LOADER = '@mergifyio/ci-native';

const failures = [];
const fail = (tgz, msg) => failures.push(`${tgz}: ${msg}`);

/** Every path inside a tarball, with the leading `package/` stripped. */
function entries(path) {
  return execFileSync('tar', ['-tzf', path], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((e) => e.replace(/^\.\//, '').replace(/^package\//, ''))
    .filter((e) => e && !e.endsWith('/'));
}

function read(path, entry) {
  return execFileSync('tar', ['-xzOf', path, `package/${entry}`]);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
// Resolved from this file rather than the cwd, so the check behaves the same
// whichever directory a workflow step happens to run it from.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rootLicense = sha(readFileSync(join(repoRoot, 'LICENSE')));

const tarballs = readdirSync(distDir)
  .filter((f) => f.endsWith('.tgz'))
  .sort();

if (tarballs.length === 0) {
  console.error(`::error::no tarballs in ${distDir}`);
  process.exit(1);
}

const seen = new Map();

for (const name of tarballs) {
  const path = join(distDir, name);
  const files = new Set(entries(path));
  let pkg;
  try {
    pkg = JSON.parse(read(path, 'package.json'));
  } catch {
    fail(name, 'no readable package.json');
    continue;
  }
  seen.set(pkg.name, pkg);

  // --- licence and readme -------------------------------------------------
  // Presence is not enough: the release copies the root LICENSE in, and a stale
  // or truncated copy would satisfy a mere existence check.
  if (!files.has('LICENSE')) fail(name, 'no LICENSE');
  else if (sha(read(path, 'LICENSE')) !== rootLicense)
    fail(name, 'LICENSE differs from the repository root LICENSE');
  // @mergifyio/ci-native carries none on purpose: it is an implementation
  // detail of the two reporters, not something anyone is meant to find on npm,
  // so it is not given a page to advertise itself with. Every other package --
  // including the seven napi platform stubs -- has one.
  if (pkg.name !== LOADER) {
    if (!files.has('README.md')) fail(name, 'no README.md');
    else if (read(path, 'README.md').length === 0) fail(name, 'README.md is empty');
  }

  // --- manifest -----------------------------------------------------------
  if (pkg.version !== expectedVersion)
    fail(name, `version is ${pkg.version}, expected ${expectedVersion}`);
  if (pkg.license !== 'Apache-2.0') fail(name, `license is ${pkg.license}, expected Apache-2.0`);

  // A `workspace:` range that survived packing makes the package uninstallable
  // for everyone. pnpm rewrites them, but nothing has ever checked that it did.
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (String(range).startsWith('workspace:'))
        fail(name, `${field}.${dep} is still "${range}"`);
    }
  }

  // --- every advertised entrypoint is actually in the tarball -------------
  // The structural cousin of the runner.js bug: a manifest pointing at a file
  // that no build emits.
  const targets = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.startsWith('./')) targets.add(posix.normalize(v.slice(2)));
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const field of ['main', 'module', 'types', 'exports']) walk(pkg[field]);
  for (const t of targets) if (!files.has(t)) fail(name, `${t} is advertised but not packed`);

  // --- nothing that should never ship ------------------------------------
  for (const f of files) {
    if (f.startsWith('node_modules/') || f === '.npmrc' || f === '.env' || f.endsWith('.pem'))
      fail(name, `packed ${f}`);
  }

  // --- napi platform packages --------------------------------------------
  if (pkg.name.startsWith(PLATFORM_PREFIX)) {
    // `main` names the .node here, and it is copied in by `napi artifacts`
    // rather than produced by the pack. When the matrix leg that builds it
    // fails or silently no-ops, the pack still succeeds and emits a ~4kB
    // package whose only fault is the missing binary.
    if (!pkg.main?.endsWith('.node')) fail(name, `main is ${pkg.main}, expected a .node`);
    else if (!files.has(pkg.main)) fail(name, `${pkg.main} is missing -- no native binary packed`);
    if (!Array.isArray(pkg.os) || pkg.os.length === 0) fail(name, 'no os field');
    if (!Array.isArray(pkg.cpu) || pkg.cpu.length === 0) fail(name, 'no cpu field');
  }
}

// --- cross-package invariants ---------------------------------------------
const loader = seen.get(LOADER);
if (!loader) {
  failures.push(`${LOADER} was not packed at all`);
} else {
  const platforms = [...seen.keys()].filter((n) => n.startsWith(PLATFORM_PREFIX)).sort();
  const pinned = Object.keys(loader.optionalDependencies ?? {}).sort();
  if (pinned.join() !== platforms.join())
    failures.push(
      `${LOADER} pins [${pinned.join(', ')}] but the release packs [${platforms.join(', ')}]`
    );
  for (const [dep, range] of Object.entries(loader.optionalDependencies ?? {}))
    if (range !== expectedVersion)
      failures.push(`${LOADER} pins ${dep}@${range}, expected ${expectedVersion}`);
}

if (failures.length) {
  for (const f of failures) console.error(`::error::${f}`);
  console.error(`\n${failures.length} problem(s) across ${tarballs.length} package(s)`);
  process.exit(1);
}

console.log(`ok: ${tarballs.length} packages, all at ${expectedVersion}`);
for (const name of [...seen.keys()].sort()) console.log(`  ${name}`);
