import type { Task } from '@vitest/runner';
import { TestRunner } from 'vitest';

// A runner that overrides `onBeforeTryTask` without calling `super`, while
// leaving `onBeforeRunTask` to the base class.
export default class SkipsTrySuper extends TestRunner {
  override async onBeforeTryTask(_test: Task): Promise<void> {}
}
