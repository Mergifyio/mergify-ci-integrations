/**
 * Vitest's separator between a suite and what it contains.
 */
const NAME_SEPARATOR = ' > ';

/**
 * What `buildTestKey` needs of a task: a name, and the suite containing it.
 *
 * Declared structurally rather than as `@vitest/runner`'s `Task` so that the
 * one public way to name a test does not drag a dev-only dependency into the
 * package's type surface, and does not change meaning across the `vitest >=3`
 * range this package supports — the two majors model tasks differently, and
 * these two fields are the part they agree on. Vitest's own `Test`, `Suite`,
 * and `File` all satisfy it.
 */
export interface TestNameNode {
  name: string;
  suite?: TestNameNode;
}

/**
 * Extract the namespace (parent suite chain) from a test's fullName and name.
 * Vitest uses ` > ` as separator.
 * e.g. fullName="MySuite > nested > test_foo", name="test_foo" => "MySuite > nested"
 */
export function extractNamespace(fullName: string, name: string): string {
  const suffix = `${NAME_SEPARATOR}${name}`;
  if (fullName.endsWith(suffix)) {
    return fullName.slice(0, -suffix.length);
  }
  return '';
}

/**
 * Build the matching key for a Vitest test: the same string the Mergify backend
 * stores as `test_name` (derived from the emitted span name). Used both for
 * quarantine list matching, for flaky-detection candidate matching, and for
 * intersecting a served test selection with what this worker collected — the
 * runner-side counterpart of `buildTestKey` in @mergifyio/playwright.
 *
 * Must match the span name produced by `emitTestCaseSpan` in @mergifyio/ci-core:
 *   namespace > function  (when namespace is non-empty)
 *   function              (when namespace is empty)
 * where `namespace` is `extractNamespace(TestCase.fullName, TestCase.name)`
 * above, and `TestCase.fullName` (`vitest/node`) stops at the module.
 *
 * The runner cannot reuse its own `Task.fullName` for this: it prefixes the file
 * path relative to the project root, and before Vitest 4 it does not exist at
 * all. Either way it is a string the server has never been sent, so matching on
 * it silently never fires. Walking `suite` upwards is what drops the file — the
 * file task is not part of that chain (the topmost suite's `suite` is undefined,
 * and a test outside any suite has none at all); `Task.fullName` carries the
 * file only because collection bakes it into the string.
 */
export function buildTestKey(task: TestNameNode): string {
  const names = [task.name];
  for (let suite = task.suite; suite; suite = suite.suite) {
    names.unshift(suite.name);
  }
  return names.join(NAME_SEPARATOR);
}
