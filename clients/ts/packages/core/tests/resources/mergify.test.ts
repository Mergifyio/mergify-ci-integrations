import { afterEach, describe, expect, it, vi } from 'vitest';
import { detect } from '../../src/resources/mergify.js';

describe('Mergify resource detector', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty when MERGIFY_TEST_JOB_NAME is not set', () => {
    vi.stubEnv('MERGIFY_TEST_JOB_NAME', '');
    expect(detect()).toEqual({});
  });

  it('returns job name when set', () => {
    vi.stubEnv('MERGIFY_TEST_JOB_NAME', 'my-test-job');
    expect(detect()).toEqual({ 'mergify.test.job.name': 'my-test-job' });
  });
});
