import { afterEach, describe, expect, it, vi } from 'vitest';
import { detect } from '../../src/resources/github-actions.js';

describe('GitHub Actions resource detector', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty when not on GitHub Actions', () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    expect(detect()).toEqual({});
  });

  it('maps all GitHub Actions env vars to attributes', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_WORKFLOW', 'CI');
    vi.stubEnv('GITHUB_JOB', 'test');
    vi.stubEnv('GITHUB_RUN_ID', '12345');
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
    vi.stubEnv('RUNNER_NAME', 'ubuntu-latest');
    vi.stubEnv('GITHUB_REF_NAME', 'main');
    vi.stubEnv('GITHUB_REF_TYPE', 'branch');
    vi.stubEnv('GITHUB_BASE_REF', '');
    vi.stubEnv('GITHUB_HEAD_REF', '');
    vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
    vi.stubEnv('GITHUB_REPOSITORY_ID', '99999');
    vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
    vi.stubEnv('GITHUB_SHA', 'abc123');
    vi.stubEnv('GITHUB_EVENT_PATH', '');

    const attrs = detect();
    expect(attrs['cicd.pipeline.name']).toBe('CI');
    expect(attrs['cicd.pipeline.task.name']).toBe('test');
    expect(attrs['cicd.pipeline.run.id']).toBe(12345);
    expect(attrs['cicd.pipeline.run.attempt']).toBe(1);
    expect(attrs['cicd.pipeline.runner.name']).toBe('ubuntu-latest');
    expect(attrs['vcs.ref.head.name']).toBe('main');
    expect(attrs['vcs.ref.head.type']).toBe('branch');
    expect(attrs['vcs.repository.name']).toBe('owner/repo');
    expect(attrs['vcs.repository.id']).toBe(99999);
    expect(attrs['vcs.repository.url.full']).toBe('https://github.com/owner/repo');
    expect(attrs['vcs.ref.head.revision']).toBe('abc123');
  });

  it('prefers GITHUB_HEAD_REF over GITHUB_REF_NAME for PRs', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_HEAD_REF', 'feature-branch');
    vi.stubEnv('GITHUB_REF_NAME', 'refs/pull/1/merge');

    const attrs = detect();
    expect(attrs['vcs.ref.head.name']).toBe('feature-branch');
  });
});
