import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export type CIProvider = 'github_actions' | 'jenkins' | 'circleci';

/**
 * Generate a 16-character hex test run ID (8 random bytes).
 */
export function generateTestRunId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Extract the namespace (parent suite chain) from a test's fullName and name.
 * Vitest uses ` > ` as separator.
 * e.g. fullName="MySuite > nested > test_foo", name="test_foo" => "MySuite > nested"
 */
export function extractNamespace(fullName: string, name: string): string {
  const suffix = ` > ${name}`;
  if (fullName.endsWith(suffix)) {
    return fullName.slice(0, -suffix.length);
  }
  return '';
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

function envToBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return false;
  try {
    return strtobool(value);
  } catch {
    return fallback;
  }
}

/** Check if running in a CI environment. */
export function isInCI(): boolean {
  return (
    envToBool(process.env.CI, !!(process.env.CI ?? '').length) ||
    envToBool(process.env.VITEST_MERGIFY_ENABLE, false)
  );
}

/** Detect the current CI provider from environment variables. */
export function getCIProvider(): CIProvider | null {
  if (process.env.GITHUB_ACTIONS) return 'github_actions';
  if (process.env.CIRCLECI) return 'circleci';
  if (process.env.JENKINS_URL) return 'jenkins';
  return null;
}

/** Execute a git command and return trimmed stdout, or null on failure. */
export function git(...args: string[]): string | null {
  try {
    return execSync(`git ${args.join(' ')}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** Split an "owner/repo" string into parts. */
export function splitRepoName(fullName: string): { owner: string; repo: string } {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/** Parse a repository name from a git remote URL (SSH or HTTPS). */
export function getRepositoryNameFromUrl(url: string): string | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // HTTPS: https://github.com/owner/repo.git
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (path.includes('/')) return path;
  } catch {
    // not a valid URL
  }

  return null;
}
