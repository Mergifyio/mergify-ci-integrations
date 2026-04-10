import 'vitest';
import type { FlakyDetectionContext, FlakyDetectionMode } from './flaky-detection.js';

declare module 'vitest' {
  interface ProvidedContext {
    'mergify:quarantine': string[];
    'mergify:flakyContext': FlakyDetectionContext | null;
    'mergify:flakyMode': FlakyDetectionMode | null;
  }
}
