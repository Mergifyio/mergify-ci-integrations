import type { Attributes } from '@opentelemetry/api';
import { getRepositoryNameFromUrl } from '../utils.js';

export function detect(): Attributes {
  if (!process.env.BUILDKITE) return {};

  const attrs: Attributes = {};
  const env = process.env;

  if (env.BUILDKITE_PIPELINE_SLUG) attrs['cicd.pipeline.name'] = env.BUILDKITE_PIPELINE_SLUG;
  if (env.BUILDKITE_LABEL || env.BUILDKITE_STEP_KEY) {
    attrs['cicd.pipeline.task.name'] = env.BUILDKITE_LABEL || env.BUILDKITE_STEP_KEY || '';
  }
  if (env.BUILDKITE_BUILD_ID) attrs['cicd.pipeline.run.id'] = env.BUILDKITE_BUILD_ID;
  if (env.BUILDKITE_BUILD_URL) attrs['cicd.pipeline.run.url'] = env.BUILDKITE_BUILD_URL;
  if (env.BUILDKITE_RETRY_COUNT !== undefined) {
    const retryCount = Number(env.BUILDKITE_RETRY_COUNT);
    if (!Number.isNaN(retryCount)) attrs['cicd.pipeline.run.attempt'] = retryCount + 1;
  }
  if (env.BUILDKITE_AGENT_NAME) attrs['cicd.pipeline.runner.name'] = env.BUILDKITE_AGENT_NAME;

  if (env.BUILDKITE_BRANCH) attrs['vcs.ref.head.name'] = env.BUILDKITE_BRANCH;
  if (env.BUILDKITE_PULL_REQUEST_BASE_BRANCH)
    attrs['vcs.ref.base.name'] = env.BUILDKITE_PULL_REQUEST_BASE_BRANCH;
  if (env.BUILDKITE_COMMIT) attrs['vcs.ref.head.revision'] = env.BUILDKITE_COMMIT;
  if (env.BUILDKITE_REPO) {
    attrs['vcs.repository.url.full'] = env.BUILDKITE_REPO;
    const repoName = getRepositoryNameFromUrl(env.BUILDKITE_REPO);
    if (repoName) attrs['vcs.repository.name'] = repoName;
  }

  return attrs;
}
