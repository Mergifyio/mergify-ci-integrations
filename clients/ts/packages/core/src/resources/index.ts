import type { Attributes } from '@opentelemetry/api';
import { type Resource, resourceFromAttributes } from '@opentelemetry/resources';
import { detectNativeContext } from '../native.js';

export function detectResources(frameworkAttributes: Attributes, testRunId: string): Resource {
  return resourceFromAttributes({
    ...(detectNativeContext()?.attributes ?? {}),
    ...frameworkAttributes,
    'test.run.id': testRunId,
  });
}
