import 'vitest';
import type { FlakyDetectionContext, FlakyDetectionMode } from '@mergifyio/ci-core';

declare module 'vitest' {
  interface ProvidedContext {
    'mergify:quarantine': string[];
    /** Provided only for a genuine `subset` answer; absent means run everything. */
    'mergify:selection': string[];
    'mergify:flakyContext': FlakyDetectionContext | null;
    'mergify:flakyMode': FlakyDetectionMode | null;
  }
}
