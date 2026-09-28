import { describe, expect, it, vi } from 'vitest';
import { LISTING_MARKER } from '../src/listing-reporter.js';
import { listPlaywrightSlice, parseListing, sliceCommand } from '../src/shard.js';

// Asking Playwright for this leg's slice is a subprocess, so the two things
// that decide whether it can be trusted are tested here: that the command
// replayed carries every filter the original run carried, and that anything
// going wrong ends in no slice at all -- never a partial or guessed one.

const argv = (...args: string[]) => ['/usr/bin/node', '/opt/pw/cli.js', ...args];

describe('sliceCommand', () => {
  it('replays the run, adding the listing and its own reporter', () => {
    expect(sliceCommand(argv('test', '--shard=2/5'))).toEqual({
      command: '/usr/bin/node',
      args: [
        '/opt/pw/cli.js',
        'test',
        '--shard=2/5',
        '--list',
        expect.stringMatching(/^--reporter=.*listing-reporter\.(ts|mjs|cjs|js)$/) as never,
      ],
    });
  });

  it('keeps every filter, because a filter left behind lists another corpus', () => {
    const { args } = sliceCommand(
      argv(
        'test',
        '-c',
        'pw.config.ts',
        '--project=chromium',
        '--grep',
        'checkout',
        '--grep-invert=slow',
        '--repeat-each=2',
        'tests/cart.spec.ts',
        '--shard=1/3'
      )
    ) as { args: string[] };

    expect(args).toEqual([
      '/opt/pw/cli.js',
      'test',
      '-c',
      'pw.config.ts',
      '--project=chromium',
      '--grep',
      'checkout',
      '--grep-invert=slow',
      '--repeat-each=2',
      'tests/cart.spec.ts',
      '--shard=1/3',
      '--list',
      expect.stringMatching(/^--reporter=/) as never,
    ]);
  });

  it("drops the run's reporters, in every spelling, with their values", () => {
    expect(
      sliceCommand(argv('test', '--add-reporter', 'html', '--shard=1/2'))?.args.slice(0, 4)
    ).toEqual(['/opt/pw/cli.js', 'test', '--shard=1/2', '--list']);
    expect(
      sliceCommand(argv('test', '--reporter', 'list', '--shard=1/2'))?.args.slice(0, 4)
    ).toEqual(['/opt/pw/cli.js', 'test', '--shard=1/2', '--list']);
    expect(sliceCommand(argv('test', '--reporter=html', '-r', 'dot'))?.args.slice(0, 3)).toEqual([
      '/opt/pw/cli.js',
      'test',
      '--list',
    ]);
  });

  it('drops what would make the listing interact instead of returning', () => {
    expect(
      sliceCommand(argv('test', '--ui', '--ui-port', '9323', '--headed'))?.args.slice(0, 3)
    ).toEqual(['/opt/pw/cli.js', 'test', '--list']);
  });

  it('refuses anything that is not a `playwright test` command line', () => {
    expect(sliceCommand(argv('show-report'))).toBeNull();
    expect(sliceCommand(['/usr/bin/node'])).toBeNull();
  });
});

describe('parseListing', () => {
  const line = (payload: unknown) =>
    `noise before\n${LISTING_MARKER}${JSON.stringify(payload)}\nnoise after`;

  it("reads the two sets off the marked line, ignoring the runner's own output", () => {
    expect(parseListing(line({ corpus: ['a', 'b', 'c'], slice: ['b'] }))).toEqual({
      corpus: ['a', 'b', 'c'],
      slice: ['b'],
    });
  });

  it('reads an empty slice as empty: a leg Playwright gives nothing is not a failure', () => {
    expect(parseListing(line({ corpus: ['a'], slice: [] }))).toEqual({ corpus: ['a'], slice: [] });
  });

  // Anything unreadable has to be null, never a partial set: a half-read
  // listing is what would exclude tests that belong to this leg.
  it('refuses a listing it cannot read', () => {
    expect(parseListing('no marker at all')).toBeNull();
    expect(parseListing(`${LISTING_MARKER}not json`)).toBeNull();
    expect(parseListing(line(null))).toBeNull();
    expect(parseListing(line({ corpus: ['a'] }))).toBeNull();
    expect(parseListing(line({ corpus: 'a', slice: [] }))).toBeNull();
    expect(parseListing(line({ corpus: [1, 2], slice: [] }))).toBeNull();
  });
});

describe('listPlaywrightSlice', () => {
  const log = () => {};
  const ok = `${LISTING_MARKER}${JSON.stringify({ corpus: ['a', 'b'], slice: ['a'] })}`;

  it('returns both sets the listing printed', () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: ok });
    expect(listPlaywrightSlice(log, argv('test', '--shard=1/2'), run)).toEqual({
      corpus: ['a', 'b'],
      slice: ['a'],
    });
  });

  // Every one of these must end in no slice: the caller then leaves sharding to
  // Playwright and runs the leg unreduced. A guessed slice would fingerprint a
  // set of tests this leg never runs.
  it('gives up when the subprocess could not be started or timed out', () => {
    const run = vi
      .fn()
      .mockReturnValue({ status: null, stdout: '', error: new Error('ETIMEDOUT') });
    expect(listPlaywrightSlice(log, argv('test', '--shard=1/2'), run)).toBeNull();
  });

  it('gives up when Playwright exits non-zero', () => {
    const run = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'config error' });
    expect(listPlaywrightSlice(log, argv('test', '--shard=1/2'), run)).toBeNull();
  });

  it('gives up when the listing is unreadable', () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: '<html>oops</html>' });
    expect(listPlaywrightSlice(log, argv('test', '--shard=1/2'), run)).toBeNull();
  });

  it('gives up when this run is not a command line it can replay', () => {
    const run = vi.fn();
    expect(listPlaywrightSlice(log, argv('show-report'), run)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('says what went wrong, so the log explains an unreduced shard', () => {
    const said: string[] = [];
    listPlaywrightSlice(
      (m) => said.push(m),
      argv('test'),
      () => ({ status: 2, stdout: '' })
    );
    expect(said.join(' ')).toContain('exited 2');
  });
});
