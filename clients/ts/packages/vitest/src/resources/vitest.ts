import type { SpanAttributes } from '@mergifyio/ci-core';

export function detect(vitestVersion: string): SpanAttributes {
  return {
    'test.framework': 'vitest',
    'test.framework.version': vitestVersion,
  };
}
