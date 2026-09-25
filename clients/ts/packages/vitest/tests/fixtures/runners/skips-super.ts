import type { Task } from '@vitest/runner';
import { TestRunner } from 'vitest';

// A runner that overrides `onBeforeRunTask` without calling `super`, which
// keeps anything built on the base class from running for its tests.
export default class SkipsSuper extends TestRunner {
  override async onBeforeRunTask(_test: Task): Promise<void> {}
}
