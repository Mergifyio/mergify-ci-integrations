import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LISTING_MARKER, type Listing } from './listing-reporter.js';

/**
 * Which tests a `--shard=k/N` leg owns, according to Playwright itself.
 *
 * A leg that opts into Test Selection has to know its own slice: the
 * fingerprint of that slice is what the engine matches the previous attempt's
 * session on. But `Reporter.preprocess` runs before Playwright shards, and the
 * suite it hands over is the whole corpus, so the reporter has to take sharding
 * over -- and then answer the question itself.
 *
 * Reimplementing Playwright's partition would mean reproducing
 * `createTestGroups`, which reads private fields and changes when Playwright's
 * grouping changes. So instead this asks Playwright, by running the same
 * command again with `--list` and `listing-reporter.ts`. The partition is
 * Playwright's by construction, through documented CLI, and a new grouping in
 * a future release is simply obeyed.
 *
 * The cost is one extra collection -- 0.66 s on a suite of 811 tests, which
 * `--list` performs without starting the web server or the global setup.
 *
 * Known limit: a suite whose collection depends on `globalSetup` would be
 * listed differently here, since `--list` does not run it. Such a run falls
 * back to a full, unreduced shard rather than to a guessed slice.
 */

/** How long the reporter waits for Playwright to list its own slice. */
const SLICE_TIMEOUT_MS = 120_000;

/** Enough of `spawnSync`'s result to decide, so a test can stand in for it. */
export interface SliceRunResult {
  status: number | null;
  stdout: string;
  stderr?: string;
  error?: Error;
}

export type SliceRunner = (command: string, args: string[]) => SliceRunResult;

/**
 * Flags dropped from the replayed command line, split on the only axis the
 * loop below cares about: whether the flag carries a value that has to go with
 * it. Naming them by topic instead would invite the next value-taking flag
 * into the valueless set, and its value would survive as a positional
 * argument -- which Playwright reads as a file filter, listing a different
 * corpus, which is the one thing this module exists to prevent.
 *
 * The reporters go because the listing wants this package's own and nothing
 * else; a second reporter replayed into it would run its side effects --
 * writing a report file, opening a server -- for a listing. The rest would
 * make the listing interact, watch or serve instead of returning.
 */
const DROPPED_FLAGS_WITH_VALUE = new Set([
  '--reporter',
  '-r',
  '--add-reporter',
  '--ui-host',
  '--ui-port',
]);

/**
 * Everything else is kept: it is either a filter -- and the listing must apply
 * the very same ones, or its slice is drawn over a different corpus -- or
 * harmless to a `--list`.
 */
const DROPPED_FLAGS = new Set(['--ui', '--watch', '--debug', '--headed', '--list']);

/**
 * The command that lists this run's own slice: this very invocation, with its
 * reporters replaced by the JSON one.
 *
 * Built from `process.argv` rather than from a list of filters we know about,
 * because the filters we do not know about are the ones that would silently
 * draw the slice over a different corpus -- a forgotten `--grep` yields a wrong
 * slice, so a wrong fingerprint, so a full run for a reason nobody can see.
 *
 * Null when this is not a `playwright test` command line -- an embedder
 * calling the runner as a library, say -- because then there is nothing
 * faithful to replay.
 */
/**
 * Where the listing reporter sits at runtime, resolved beside this module.
 *
 * Its extension is this module's own: tsdown emits `.mjs` and `.cjs`, and a
 * checkout running from source is `.ts`. Unlike a config's `reporter:` entry, a
 * `--reporter=<path>` on the command line is resolved by Node and NOT by
 * Playwright's TypeScript loader, so `listing-reporter.js` beside a `.ts`
 * module resolves to nothing and every sharded leg would fail open.
 */
function listingReporterPath(): string {
  const current = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const ext = ['.cjs', '.mjs', '.ts'].find((candidate) => current.endsWith(candidate)) ?? '.js';
  return resolve(dirname(current), `listing-reporter${ext}`);
}

export function sliceCommand(argv: readonly string[]): { command: string; args: string[] } | null {
  const [command, cli, ...rest] = argv;
  // A shorter argv leaves `rest[0]` undefined, which this already refuses.
  if (rest[0] !== 'test' || !command || !cli) return null;

  const args: string[] = [cli];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const flag = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (DROPPED_FLAGS_WITH_VALUE.has(flag)) {
      if (flag === arg) i++; // `--reporter json`, not `--reporter=json`
      continue;
    }
    if (DROPPED_FLAGS.has(flag)) continue;
    args.push(arg);
  }
  args.push('--list', `--reporter=${listingReporterPath()}`);
  return { command, args };
}

/**
 * The two id sets the listing reporter printed, or null when its line is
 * absent or unreadable. Anything else on stdout -- a runner banner, a plugin's
 * chatter -- is ignored; only the marked line counts.
 */
export function parseListing(stdout: string): Listing | null {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(LISTING_MARKER));
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(LISTING_MARKER.length));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { corpus, slice } = parsed as { corpus?: unknown; slice?: unknown };
  if (!Array.isArray(corpus) || !Array.isArray(slice)) return null;
  if (!corpus.every((id) => typeof id === 'string')) return null;
  if (!slice.every((id) => typeof id === 'string')) return null;
  return { corpus: corpus as string[], slice: slice as string[] };
}

const defaultRunner: SliceRunner = (command, args) =>
  spawnSync(command, args, {
    encoding: 'utf8',
    timeout: SLICE_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
    // The nested run must not itself ask Mergify anything. The `--reporter`
    // override already replaces the main reporter; the variable is there so a
    // run that somehow loads it can recognise itself, and so the nested run is
    // identifiable in a process listing.
    env: { ...process.env, MERGIFY_LISTING_SHARD: '1' },
  });

/**
 * Ask Playwright what it collected and what it gives this leg. Null means the
 * question could not be answered, and the caller must then leave sharding to
 * Playwright and run the shard unreduced -- never a slice this module guessed.
 */
export function listPlaywrightSlice(
  log: (message: string) => void,
  argv: readonly string[] = process.argv,
  run: SliceRunner = defaultRunner
): Listing | null {
  if (process.env.MERGIFY_LISTING_SHARD === '1') {
    log('already listing a shard; this run takes no selection');
    return null;
  }
  const command = sliceCommand(argv);
  if (!command) {
    log('this run is not a `playwright test` command line, so its shard cannot be listed');
    return null;
  }
  const result = run(command.command, command.args);
  if (result.error) {
    log(`Playwright could not list this shard: ${result.error.message}`);
    return null;
  }
  if (result.status !== 0) {
    log(
      `Playwright exited ${result.status ?? 'without a status'} while listing this shard` +
        `${result.stderr ? `: ${result.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`
    );
    return null;
  }
  const listing = parseListing(result.stdout);
  if (listing === null) {
    log('Playwright listed this shard in a shape this reporter cannot read');
    return null;
  }
  return listing;
}
