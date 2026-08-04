import { afterEach, describe, expect, it, vi } from 'vitest';
import { detect } from '../../src/resources/jenkins.js';

describe('Jenkins resource detector', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty when not on Jenkins', () => {
    vi.stubEnv('JENKINS_URL', '');
    expect(detect()).toEqual({});
  });

  it('maps Jenkins env vars to attributes', () => {
    vi.stubEnv('JENKINS_URL', 'http://jenkins.example.com');
    vi.stubEnv('JOB_NAME', 'my-job');
    vi.stubEnv('BUILD_ID', '42');
    vi.stubEnv('BUILD_URL', 'http://jenkins.example.com/job/my-job/42');
    vi.stubEnv('NODE_NAME', 'worker-1');
    vi.stubEnv('GIT_BRANCH', 'origin/main');
    vi.stubEnv('GIT_COMMIT', 'def456');
    vi.stubEnv('GIT_URL', 'https://github.com/owner/repo.git');

    const attrs = detect();
    expect(attrs['cicd.pipeline.name']).toBe('my-job');
    expect(attrs['cicd.pipeline.run.id']).toBe('42');
    expect(attrs['cicd.pipeline.runner.name']).toBe('worker-1');
    expect(attrs['vcs.ref.head.name']).toBe('main');
    expect(attrs['vcs.ref.head.revision']).toBe('def456');
    expect(attrs['vcs.repository.url.full']).toBe('https://github.com/owner/repo.git');
    expect(attrs['vcs.repository.name']).toBe('owner/repo');
  });

  it('strips origin/ and refs/heads/ prefixes from GIT_BRANCH', () => {
    vi.stubEnv('JENKINS_URL', 'http://jenkins.example.com');
    vi.stubEnv('GIT_BRANCH', 'refs/heads/feature');

    const attrs = detect();
    expect(attrs['vcs.ref.head.name']).toBe('feature');
  });
});
