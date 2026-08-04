import { describe, expect, it } from 'vitest';
import { withMergify } from '../src/with-mergify.js';

function asArray(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

describe('withMergify', () => {
  it('appends the reporter + globalSetup + globalTeardown to an empty config', () => {
    const result = withMergify({});
    const reporters = asArray(result.reporter);
    expect(reporters.length).toBeGreaterThan(0);
    expect(asArray(result.globalSetup)).toHaveLength(1);
    expect(asArray(result.globalTeardown)).toHaveLength(1);
    expect(String(asArray(result.globalSetup)[0])).toMatch(/global-setup\.(m?js|ts)$/);
    expect(String(asArray(result.globalTeardown)[0])).toMatch(/global-teardown\.(m?js|ts)$/);
  });

  it('preserves existing globalSetup and globalTeardown paths', () => {
    const result = withMergify({
      globalSetup: '/u/pre-setup.ts',
      globalTeardown: ['/u/pre-teardown.ts'],
    });
    const setups = asArray(result.globalSetup);
    const teardowns = asArray(result.globalTeardown);
    expect(setups).toHaveLength(2);
    expect(setups[0]).toBe('/u/pre-setup.ts');
    expect(teardowns).toHaveLength(2);
    expect(teardowns[0]).toBe('/u/pre-teardown.ts');
  });

  it('preserves existing reporter entries', () => {
    const result = withMergify({ reporter: [['list'], ['junit', { outputFile: 'r.xml' }]] });
    const reporters = asArray(result.reporter);
    expect(reporters).toHaveLength(3);
    expect(reporters[0]).toEqual(['list']);
    expect(reporters[1]).toEqual(['junit', { outputFile: 'r.xml' }]);
  });

  it('coerces a string reporter to array form before appending', () => {
    const result = withMergify({ reporter: 'html' });
    const reporters = asArray(result.reporter);
    expect(reporters).toHaveLength(2);
    expect(reporters[0]).toEqual(['html']);
  });
});
