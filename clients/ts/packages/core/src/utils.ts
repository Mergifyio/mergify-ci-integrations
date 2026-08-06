import { randomBytes } from 'node:crypto';
import type { Attributes } from '@opentelemetry/api';
import { detectNativeProvider, detectNativeRepositoryName } from './native.js';

export type CIProvider = 'github_actions' | 'jenkins' | 'circleci' | 'buildkite';

/**
 * Generate a 16-character hex test run ID (8 random bytes).
 */
export function generateTestRunId(): string {
  return randomBytes(8).toString('hex');
}

const TRUTHY_VALUES = new Set(['y', 'yes', 't', 'true', 'on', '1']);
const FALSY_VALUES = new Set(['n', 'no', 'f', 'false', 'off', '0']);

/** Convert a string to a boolean. */
export function strtobool(value: string): boolean {
  const lower = value.toLowerCase();
  if (TRUTHY_VALUES.has(lower)) return true;
  if (FALSY_VALUES.has(lower)) return false;
  throw new Error(`Could not convert '${value}' to boolean`);
}

export function envToBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return false;
  try {
    return strtobool(value);
  } catch {
    return fallback;
  }
}

/** Check if running in a CI environment. */
export function isInCI(): boolean {
  return envToBool(process.env.CI, !!(process.env.CI ?? '').length);
}

/** Detect the current CI provider via the bundled Rust core. */
export function getCIProvider(): CIProvider | null {
  return detectNativeProvider() as CIProvider | null;
}

/** Split an "owner/repo" string into parts. */
export function splitRepoName(fullName: string): { owner: string; repo: string } {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Resolve the API-endpoint repository name ("owner/repo") via the bundled
 * Rust core: the active provider's environment first, the git remote as
 * fallback.
 */
export function getRepoName(): string | undefined {
  return detectNativeRepositoryName();
}

/**
 * Resolve the branch name for quarantine/flaky-detection lookups from OTel
 * resource attributes: `vcs.ref.base.name` (PR target) preferred, then
 * `vcs.ref.head.name` (push branch / PR head). Empty strings fall through.
 */
export function resolveBranchFromAttributes(attrs: Attributes): string | undefined {
  const base = attrs['vcs.ref.base.name'];
  if (typeof base === 'string' && base.length > 0) return base;
  const head = attrs['vcs.ref.head.name'];
  if (typeof head === 'string' && head.length > 0) return head;
  return undefined;
}
