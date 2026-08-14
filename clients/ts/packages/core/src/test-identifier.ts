/**
 * The separator between suite levels in a test identifier. Vitest's own, and
 * therefore ours — the identifier we upload has to be the one a later run can
 * reproduce and match.
 */
export const TEST_NAME_SEPARATOR = ' > ';

/**
 * The identifier of one test: its parent suite chain then its own name, with no
 * file path.
 *
 * This is the ONE construction. The reporter uploads what it returns and the
 * runner matches served identifiers against what it returns, so the two cannot
 * drift — which is exactly how they drifted before: the reporter uploaded
 * `suite > test` while the runner compared `file.test.ts > suite > test`, and no
 * server-provided name could ever match.
 *
 * Any client matching a name Mergify served — quarantine, flaky detection, test
 * selection — must go through here rather than build the string itself.
 */
export function buildTestIdentifier(namespace: string, name: string): string {
  return namespace.length > 0 ? `${namespace}${TEST_NAME_SEPARATOR}${name}` : name;
}
