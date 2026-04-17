import { afterEach, describe, expect, it, vi } from 'vitest';
import { detect } from '../../src/resources/ci.js';

describe('CI resource detector', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty when no CI provider is detected', () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('CIRCLECI', '');
    vi.stubEnv('JENKINS_URL', '');
    vi.stubEnv('BUILDKITE', '');
    expect(detect()).toEqual({});
  });

  it('detects GitHub Actions', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    expect(detect()).toEqual({ 'cicd.provider.name': 'github_actions' });
  });

  it('detects Jenkins', () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('JENKINS_URL', 'http://jenkins.example.com');
    expect(detect()).toEqual({ 'cicd.provider.name': 'jenkins' });
  });

  it('detects CircleCI', () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('CIRCLECI', 'true');
    expect(detect()).toEqual({ 'cicd.provider.name': 'circleci' });
  });

  it('detects Buildkite', () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('BUILDKITE', 'true');
    expect(detect()).toEqual({ 'cicd.provider.name': 'buildkite' });
  });
});
