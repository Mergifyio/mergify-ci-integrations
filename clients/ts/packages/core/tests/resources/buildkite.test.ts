import { afterEach, describe, expect, it, vi } from 'vitest';
import { detect } from '../../src/resources/buildkite.js';

describe('Buildkite resource detector', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty when not on Buildkite', () => {
    vi.stubEnv('BUILDKITE', '');
    expect(detect()).toEqual({});
  });

  it('maps all Buildkite env vars to attributes', () => {
    vi.stubEnv('BUILDKITE', 'true');
    vi.stubEnv('BUILDKITE_PIPELINE_SLUG', 'my-pipeline');
    vi.stubEnv('BUILDKITE_LABEL', 'Run tests');
    vi.stubEnv('BUILDKITE_STEP_KEY', 'test-step');
    vi.stubEnv('BUILDKITE_BUILD_ID', 'abc-123');
    vi.stubEnv('BUILDKITE_BUILD_URL', 'https://buildkite.com/org/pipeline/builds/42');
    vi.stubEnv('BUILDKITE_RETRY_COUNT', '0');
    vi.stubEnv('BUILDKITE_AGENT_NAME', 'agent-1');
    vi.stubEnv('BUILDKITE_BRANCH', 'main');
    vi.stubEnv('BUILDKITE_PULL_REQUEST_BASE_BRANCH', 'develop');
    vi.stubEnv('BUILDKITE_COMMIT', 'abc123def');
    vi.stubEnv('BUILDKITE_REPO', 'https://github.com/owner/repo.git');

    const attrs = detect();
    expect(attrs['cicd.pipeline.name']).toBe('my-pipeline');
    expect(attrs['cicd.pipeline.task.name']).toBe('Run tests');
    expect(attrs['cicd.pipeline.run.id']).toBe('abc-123');
    expect(attrs['cicd.pipeline.run.url']).toBe('https://buildkite.com/org/pipeline/builds/42');
    expect(attrs['cicd.pipeline.run.attempt']).toBe(1);
    expect(attrs['cicd.pipeline.runner.name']).toBe('agent-1');
    expect(attrs['vcs.ref.head.name']).toBe('main');
    expect(attrs['vcs.ref.base.name']).toBe('develop');
    expect(attrs['vcs.ref.head.revision']).toBe('abc123def');
    expect(attrs['vcs.repository.url.full']).toBe('https://github.com/owner/repo.git');
    expect(attrs['vcs.repository.name']).toBe('owner/repo');
  });

  it('uses BUILDKITE_STEP_KEY when BUILDKITE_LABEL is not set', () => {
    vi.stubEnv('BUILDKITE', 'true');
    vi.stubEnv('BUILDKITE_STEP_KEY', 'lint-step');

    const attrs = detect();
    expect(attrs['cicd.pipeline.task.name']).toBe('lint-step');
  });

  it('converts retry count to 1-based attempt number', () => {
    vi.stubEnv('BUILDKITE', 'true');
    vi.stubEnv('BUILDKITE_RETRY_COUNT', '2');

    const attrs = detect();
    expect(attrs['cicd.pipeline.run.attempt']).toBe(3);
  });

  it('handles retry count of 0 as first attempt', () => {
    vi.stubEnv('BUILDKITE', 'true');
    vi.stubEnv('BUILDKITE_RETRY_COUNT', '0');

    const attrs = detect();
    expect(attrs['cicd.pipeline.run.attempt']).toBe(1);
  });

  it('ignores non-numeric retry count', () => {
    vi.stubEnv('BUILDKITE', 'true');
    vi.stubEnv('BUILDKITE_RETRY_COUNT', 'invalid');

    const attrs = detect();
    expect(attrs['cicd.pipeline.run.attempt']).toBeUndefined();
  });

  it('parses repo URL to extract repository name', () => {
    vi.stubEnv('BUILDKITE', 'true');
    vi.stubEnv('BUILDKITE_REPO', 'git@github.com:owner/repo.git');

    const attrs = detect();
    expect(attrs['vcs.repository.url.full']).toBe('git@github.com:owner/repo.git');
    expect(attrs['vcs.repository.name']).toBe('owner/repo');
  });
});
