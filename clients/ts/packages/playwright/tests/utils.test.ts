import { describe, expect, it } from 'vitest';
import { extractNamespace, mapStatus, projectNameFromTest } from '../src/utils.js';

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
