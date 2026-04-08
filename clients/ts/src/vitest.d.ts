import 'vitest';

declare module 'vitest' {
  interface ProvidedContext {
    'mergify:quarantine': string[];
  }
}
