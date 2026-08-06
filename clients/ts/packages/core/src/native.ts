import { createRequire } from 'node:module';

/**
 * Mirrors mergify-ci-core's `CiResourceAttributes` (otel.rs): the typed OTel
 * projection of the detected CI context. Every key is optional — absent when
 * the provider does not supply it or outside CI. The index signature covers
 * provider-specific extras (the core's `extra` map).
 */
export interface CiResourceAttributes {
  'mergify.test.job.name'?: string;
  'cicd.provider.name'?: string;
  'vcs.repository.name'?: string;
  'vcs.repository.url.full'?: string;
  'vcs.repository.id'?: number;
  'vcs.ref.head.name'?: string;
  'vcs.ref.head.revision'?: string;
  'vcs.ref.head.type'?: string;
  'vcs.ref.base.name'?: string;
  'cicd.pipeline.name'?: string;
  'cicd.pipeline.task.name'?: string;
  /** Int on GitHub Actions, string on Jenkins/CircleCI/Buildkite. */
  'cicd.pipeline.run.id'?: number | string;
  'cicd.pipeline.run.attempt'?: number;
  'cicd.pipeline.runner.name'?: string;
  'cicd.pipeline.run.url'?: string;
  [extra: string]: string | number | undefined;
}

interface NativeBinding {
  detectProvider(): string | null;
  detectRepositoryName(): string | null;
  detectAttributes(): CiResourceAttributes;
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
 * The detected CI provider via the bundled Rust core, or null when not in CI
 * (or without a binding). Re-detects on every call — the environment is read
 * at call time.
 */
export function detectNativeProvider(): string | null {
  if (!binding) return null;
  try {
    return binding.detectProvider();
  } catch {
    return null;
  }
}

/**
 * The API-endpoint "owner/repo" via the bundled Rust core: the active
 * provider's environment first, the git remote as fallback. Undefined when
 * undeterminable (or without a binding).
 */
export function detectNativeRepositoryName(): string | undefined {
  if (!binding) return undefined;
  try {
    return binding.detectRepositoryName() ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The OTel resource attributes via the bundled Rust core. Empty outside CI —
 * and on platforms without a binding, which is the fail-open path.
 */
export function detectNativeAttributes(): CiResourceAttributes {
  if (!binding) return {};
  try {
    return binding.detectAttributes();
  } catch {
    return {};
  }
}
