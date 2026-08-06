import type { Attributes } from '@opentelemetry/api';
import { type Resource, resourceFromAttributes } from '@opentelemetry/resources';
import { detectNativeAttributes } from '../native.js';

export function detectResources(frameworkAttributes: Attributes, testRunId: string): Resource {
  return resourceFromAttributes({
    ...detectNativeAttributes(),
    ...frameworkAttributes,
    'test.run.id': testRunId,
  });
}
