import { createRequire } from 'node:module';
import type { SpanAttributes } from '@mergifyio/ci-core';

function readPlaywrightVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@playwright/test/package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function detect(): SpanAttributes {
  return {
    'test.framework': 'playwright',
    'test.framework.version': readPlaywrightVersion(),
  };
}
