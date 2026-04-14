import type { Attributes } from '@opentelemetry/api';
import { getCIProvider, getRepositoryNameFromUrl, git } from '../utils.js';

/** Fallback VCS detection via git CLI. Only runs when a CI provider is detected. */
export function detect(): Attributes {
  if (!getCIProvider()) return {};

  const attrs: Attributes = {};

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch && branch !== 'HEAD') {
    attrs['vcs.ref.head.name'] = branch;
  }

  const revision = git('rev-parse', 'HEAD');
  if (revision) {
    attrs['vcs.ref.head.revision'] = revision;
  }

  const remoteUrl = git('config', '--get', 'remote.origin.url');
  if (remoteUrl) {
    attrs['vcs.repository.url.full'] = remoteUrl;
    const repoName = getRepositoryNameFromUrl(remoteUrl);
    if (repoName) {
      attrs['vcs.repository.name'] = repoName;
    }
  }

  return attrs;
}
