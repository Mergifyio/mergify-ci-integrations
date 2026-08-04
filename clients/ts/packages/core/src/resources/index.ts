import type { Attributes } from '@opentelemetry/api';
import { type Resource, resourceFromAttributes } from '@opentelemetry/resources';
import * as buildkite from './buildkite.js';
import * as ci from './ci.js';
import * as git from './git.js';
import * as githubActions from './github-actions.js';
import * as jenkins from './jenkins.js';
import * as mergify from './mergify.js';

export function detectResources(frameworkAttributes: Attributes, testRunId: string): Resource {
  return resourceFromAttributes({
    ...git.detect(),
    ...ci.detect(),
    ...githubActions.detect(),
    ...jenkins.detect(),
    ...buildkite.detect(),
    ...mergify.detect(),
    ...frameworkAttributes,
    'test.run.id': testRunId,
  });
}
