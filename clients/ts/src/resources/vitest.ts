import type { Attributes } from '@opentelemetry/api';

export function detect(vitestVersion: string): Attributes {
  return {
    'test.framework': 'vitest',
    'test.framework.version': vitestVersion,
  };
}
