import { randomBytes } from 'node:crypto';

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
