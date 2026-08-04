import { createRequire } from 'node:module';
import type { Attributes } from '@opentelemetry/api';

function readPlaywrightVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@playwright/test/package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function detect(): Attributes {
  return {
    'test.framework': 'playwright',
    'test.framework.version': readPlaywrightVersion(),
  };
}
