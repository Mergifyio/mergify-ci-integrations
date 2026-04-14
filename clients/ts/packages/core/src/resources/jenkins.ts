import type { Attributes } from '@opentelemetry/api';
import { getRepositoryNameFromUrl } from '../utils.js';

function stripBranchPrefix(branch: string): string {
  return branch.replace(/^origin\//, '').replace(/^refs\/heads\//, '');
}

export function detect(): Attributes {
  if (!process.env.JENKINS_URL) return {};

  const attrs: Attributes = {};
  const env = process.env;

  if (env.JOB_NAME) {
    attrs['cicd.pipeline.name'] = env.JOB_NAME;
    attrs['cicd.pipeline.task.name'] = env.JOB_NAME;
  }
  if (env.BUILD_ID) attrs['cicd.pipeline.run.id'] = env.BUILD_ID;
  if (env.BUILD_URL) attrs['cicd.pipeline.run.url'] = env.BUILD_URL;
  if (env.NODE_NAME) attrs['cicd.pipeline.runner.name'] = env.NODE_NAME;

  if (env.GIT_BRANCH) attrs['vcs.ref.head.name'] = stripBranchPrefix(env.GIT_BRANCH);
  if (env.GIT_COMMIT) attrs['vcs.ref.head.revision'] = env.GIT_COMMIT;
  if (env.GIT_URL) {
    attrs['vcs.repository.url.full'] = env.GIT_URL;
    const repoName = getRepositoryNameFromUrl(env.GIT_URL);
    if (repoName) attrs['vcs.repository.name'] = repoName;
  }

  return attrs;
}
