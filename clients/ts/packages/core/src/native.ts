import { createRequire } from 'node:module';
import type { ApiClientOptions, CiApiClient } from '@mergifyio/ci-native';

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
  CiApiClient: new (options: ApiClientOptions) => CiApiClient;
}

/**
 * The @mergifyio/ci-native binding, or null when the platform has no prebuilt
 * binary. Fail-open by design: without a binding, detection reports nothing
 * and the backend features stay off rather than breaking the test run.
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

/**
 * The bundled Rust API client for one repository, or null when the platform
 * has no binding or the options are rejected (a `repoName` that is not an
 * `owner/repo` pair). Same fail-open contract as detection.
 */
export function createNativeApiClient(options: ApiClientOptions): CiApiClient | null {
  if (!binding) return null;
  try {
    return new binding.CiApiClient(options);
  } catch {
    return null;
  }
}
