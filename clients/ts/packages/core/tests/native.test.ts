import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectResources } from '../src/resources/index.js';
import { getCIProvider, getRepoName } from '../src/utils.js';

// Wiring smoke tests: the binding's attributes reach the OTel resource and the
// helper functions. Detection logic itself is covered by mergify-ci-core's
// Rust test suite.

const CI_VARS = [
  'GITHUB_ACTIONS',
  'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_ID',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_WORKFLOW',
  'GITHUB_JOB',
  'GITHUB_REF_NAME',
  'GITHUB_REF_TYPE',
  'GITHUB_HEAD_REF',
  'GITHUB_BASE_REF',
  'GITHUB_SERVER_URL',
  'GITHUB_SHA',
  'GITHUB_EVENT_NAME',
  'GITHUB_EVENT_PATH',
  'RUNNER_NAME',
  'CIRCLECI',
  'JENKINS_URL',
  'BUILDKITE',
  '_PYTEST_MERGIFY_TEST',
  'MERGIFY_TEST_JOB_NAME',
];

describe('native detection wiring', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of CI_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of CI_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('surfaces binding attributes in the resource', () => {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_REPOSITORY = 'Mergifyio/example';
    process.env.GITHUB_RUN_ID = '42';

    const resource = detectResources({ 'test.framework': 'vitest' }, 'run-1');
    expect(resource.attributes['cicd.provider.name']).toBe('github_actions');
    expect(resource.attributes['vcs.repository.name']).toBe('Mergifyio/example');
    // Integer attributes stay integers across the JSON bridge.
    expect(resource.attributes['cicd.pipeline.run.id']).toBe(42);
    expect(resource.attributes['test.framework']).toBe('vitest');
    expect(resource.attributes['test.run.id']).toBe('run-1');
  });

  it('surfaces provider and repository name through the helpers', () => {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_REPOSITORY = 'Mergifyio/example';

    expect(getCIProvider()).toBe('github_actions');
    expect(getRepoName()).toBe('Mergifyio/example');
  });

  it('emits no provider-scoped attributes outside CI', () => {
    const resource = detectResources({}, 'run-2');
    expect(resource.attributes['cicd.provider.name']).toBeUndefined();
    expect(resource.attributes['test.run.id']).toBe('run-2');
    expect(getCIProvider()).toBeNull();
  });
});
