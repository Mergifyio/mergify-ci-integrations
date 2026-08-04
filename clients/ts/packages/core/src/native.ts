import { createRequire } from 'node:module';

export interface NativeCiContext {
  provider: string | null;
  repositoryName: string | null;
  attributes: Record<string, string | number>;
}

interface NativeBinding {
  detectJson(): string;
}

/**
 * The @mergifyio/ci-native binding, or null when the platform has no prebuilt
 * binary. Fail-open by design: without a binding, detection reports nothing
 * rather than breaking the test run.
 */
function loadBinding(): NativeBinding | null {
  try {
    return createRequire(import.meta.url)('@mergifyio/ci-native') as NativeBinding;
  } catch {
    return null;
  }
}

const binding = loadBinding();

/**
 * Detect the CI context (provider, endpoint repository name, OTel resource
 * attributes) from the process environment via the bundled Rust core.
 *
 * Re-detects on every call — the environment is read at call time, not module
 * load — so callers see current values.
 */
export function detectNativeContext(): NativeCiContext | null {
  if (!binding) return null;
  try {
    return JSON.parse(binding.detectJson()) as NativeCiContext;
  } catch {
    return null;
  }
}
