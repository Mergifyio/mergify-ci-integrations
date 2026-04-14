import type { Attributes } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import * as ci from './ci.js';
import * as git from './git.js';
import * as githubActions from './github-actions.js';
import * as jenkins from './jenkins.js';
import * as mergify from './mergify.js';

export function detectResources(frameworkAttributes: Attributes, testRunId: string): Resource {
  return new Resource({
    ...git.detect(),
    ...ci.detect(),
    ...githubActions.detect(),
    ...jenkins.detect(),
    ...mergify.detect(),
    ...frameworkAttributes,
    'test.run.id': testRunId,
  });
}
