import { readFileSync } from 'node:fs';
import type { Attributes } from '@opentelemetry/api';

function getHeadRefName(): string | undefined {
  return process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
}

function getHeadRevision(): string | undefined {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf-8'));
      if (event?.pull_request?.head?.sha) {
        return event.pull_request.head.sha;
      }
    } catch {
      // fall through to GITHUB_SHA
    }
  }
  return process.env.GITHUB_SHA;
}

function getRepositoryUrl(): string | undefined {
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  if (serverUrl && repo) return `${serverUrl}/${repo}`;
  return undefined;
}

export function detect(): Attributes {
  if (!process.env.GITHUB_ACTIONS) return {};

  const attrs: Attributes = {};
  const env = process.env;

  if (env.GITHUB_WORKFLOW) attrs['cicd.pipeline.name'] = env.GITHUB_WORKFLOW;
  if (env.GITHUB_JOB) attrs['cicd.pipeline.task.name'] = env.GITHUB_JOB;
  if (env.GITHUB_RUN_ID) attrs['cicd.pipeline.run.id'] = Number(env.GITHUB_RUN_ID);
  if (env.GITHUB_RUN_ATTEMPT) attrs['cicd.pipeline.run.attempt'] = Number(env.GITHUB_RUN_ATTEMPT);
  if (env.RUNNER_NAME) attrs['cicd.pipeline.runner.name'] = env.RUNNER_NAME;

  const headRef = getHeadRefName();
  if (headRef) attrs['vcs.ref.head.name'] = headRef;
  if (env.GITHUB_REF_TYPE) attrs['vcs.ref.head.type'] = env.GITHUB_REF_TYPE;
  if (env.GITHUB_BASE_REF) attrs['vcs.ref.base.name'] = env.GITHUB_BASE_REF;

  if (env.GITHUB_REPOSITORY) attrs['vcs.repository.name'] = env.GITHUB_REPOSITORY;
  if (env.GITHUB_REPOSITORY_ID) attrs['vcs.repository.id'] = Number(env.GITHUB_REPOSITORY_ID);

  const repoUrl = getRepositoryUrl();
  if (repoUrl) attrs['vcs.repository.url.full'] = repoUrl;

  const revision = getHeadRevision();
  if (revision) attrs['vcs.ref.head.revision'] = revision;

  return attrs;
}
