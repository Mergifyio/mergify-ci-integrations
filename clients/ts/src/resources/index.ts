import { Resource } from '@opentelemetry/resources';
import * as ci from './ci.js';
import * as git from './git.js';
import * as githubActions from './github-actions.js';
import * as jenkins from './jenkins.js';
import * as mergify from './mergify.js';
import * as vitest from './vitest.js';

export function detectResources(vitestVersion: string, testRunId: string): Resource {
  return new Resource({
    ...git.detect(),
    ...ci.detect(),
    ...githubActions.detect(),
    ...jenkins.detect(),
    ...mergify.detect(),
    ...vitest.detect(vitestVersion),
    'test.run.id': testRunId,
  });
}
