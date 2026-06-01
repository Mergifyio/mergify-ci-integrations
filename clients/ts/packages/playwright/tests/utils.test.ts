import { describe, expect, it } from 'vitest';
import {
  buildTestKey,
  extractNamespace,
  mapStatus,
  projectNameFromTest,
  toPosix,
} from '../src/utils.js';

describe('extractNamespace', () => {
  it('prefixes the describe chain with the filepath', () => {
    expect(
      extractNamespace('tests/foo.spec.ts', [
        'chromium',
        'tests/foo.spec.ts',
        'outer',
        'inner',
        'my test',
      ])
    ).toBe('tests/foo.spec.ts > outer > inner');
  });

  it('returns just the filepath when there is no describe', () => {
    expect(
      extractNamespace('tests/foo.spec.ts', ['chromium', 'tests/foo.spec.ts', 'my test'])
    ).toBe('tests/foo.spec.ts');
  });

  it('handles a single describe', () => {
    expect(
      extractNamespace('tests/foo.spec.ts', ['chromium', 'tests/foo.spec.ts', 'outer', 'my test'])
    ).toBe('tests/foo.spec.ts > outer');
  });

  it('drops empty segments so the result has no leading or trailing separator', () => {
    expect(extractNamespace('', ['', '', 'outer', 'my test'])).toBe('outer');
  });
});

describe('toPosix', () => {
  it('is a no-op on POSIX-style paths', () => {
    expect(toPosix('tests/sample.spec.ts')).toBe('tests/sample.spec.ts');
  });

  it('replaces backslashes with forward slashes (Windows input)', () => {
    expect(toPosix('tests\\sample.spec.ts')).toBe('tests/sample.spec.ts');
  });

  it('handles mixed separators', () => {
    expect(toPosix('packages\\core/src\\types.ts')).toBe('packages/core/src/types.ts');
  });

  it('returns empty string unchanged', () => {
    expect(toPosix('')).toBe('');
  });
});

describe('extractNamespace — Windows-style input', () => {
  it('produces POSIX-separated output when the caller pre-normalizes with toPosix', () => {
    const winPath = toPosix('tests\\sample.spec.ts');
    expect(extractNamespace(winPath, ['', 'chromium', 'sample.spec.ts', 'my test'])).toBe(
      'tests/sample.spec.ts'
    );
  });
});

describe('mapStatus', () => {
  it.each([
    ['passed', 'passed'],
    ['skipped', 'skipped'],
    ['failed', 'failed'],
    ['timedOut', 'failed'],
    ['interrupted', 'failed'],
  ] as const)('maps %s to %s', (input, expected) => {
    expect(mapStatus(input)).toBe(expected);
  });
});

describe('projectNameFromTest', () => {
  it('returns the first entry of titlePath as the project name', () => {
    const fakeTest = {
      titlePath: () => ['firefox', 'tests/x.spec.ts', 'my test'],
    } as unknown as Parameters<typeof projectNameFromTest>[0];
    expect(projectNameFromTest(fakeTest)).toBe('firefox');
  });

  it('returns undefined when titlePath first entry is empty', () => {
    const fakeTest = {
      titlePath: () => ['', 'tests/x.spec.ts', 'my test'],
    } as unknown as Parameters<typeof projectNameFromTest>[0];
    expect(projectNameFromTest(fakeTest)).toBeUndefined();
  });
});

describe('buildTestKey', () => {
  it('joins filepath, describes, and title with " > "', () => {
    expect(
      buildTestKey(
        'tests/auth.spec.ts',
        ['chromium', 'tests/auth.spec.ts', 'Login', 'submits form'],
        'submits form'
      )
    ).toBe('tests/auth.spec.ts > Login > submits form');
  });

  it('omits the describe chain when empty', () => {
    expect(
      buildTestKey(
        'tests/auth.spec.ts',
        ['chromium', 'tests/auth.spec.ts', 'submits form'],
        'submits form'
      )
    ).toBe('tests/auth.spec.ts > submits form');
  });

  it('drops empty segments', () => {
    expect(buildTestKey('', ['', '', 'Outer', 'my test'], 'my test')).toBe('Outer > my test');
  });

  it('agrees with extractNamespace + " > " + title (parity guard)', () => {
    const filepath = 'tests/foo.spec.ts';
    const titlePath = ['chromium', 'tests/foo.spec.ts', 'Outer', 'Inner', 'case name'];
    const title = 'case name';
    expect(buildTestKey(filepath, titlePath, title)).toBe(
      `${extractNamespace(filepath, titlePath)} > ${title}`
    );
  });

  it('matches the span-name formula when namespace is empty (no filepath, no describes)', () => {
    const filepath = '';
    const titlePath = ['', '', 'solo'];
    const title = 'solo';
    const namespace = extractNamespace(filepath, titlePath);
    const expectedSpanName = namespace.length > 0 ? `${namespace} > ${title}` : title;
    expect(buildTestKey(filepath, titlePath, title)).toBe(expectedSpanName);
  });

  it('dedupes the file suite from titlePath (Playwright runtime format)', () => {
    // At runtime Playwright exposes the test file as a Suite, so titlePath is
    //   ['', 'node', 'sample.spec.ts', 'quarantined-fails']
    // Without the dedup step the key would be
    //   "tests/sample.spec.ts > sample.spec.ts > quarantined-fails"
    expect(
      buildTestKey(
        'tests/sample.spec.ts',
        ['', 'node', 'sample.spec.ts', 'quarantined-fails'],
        'quarantined-fails'
      )
    ).toBe('tests/sample.spec.ts > quarantined-fails');
  });

  it('dedupes when titlePath contains the full filepath rather than the basename', () => {
    expect(
      buildTestKey(
        'tests/sample.spec.ts',
        ['', 'node', 'tests/sample.spec.ts', 'describe', 'case'],
        'case'
      )
    ).toBe('tests/sample.spec.ts > describe > case');
  });
});
