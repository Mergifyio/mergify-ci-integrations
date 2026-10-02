import type { Task } from '@vitest/runner';
import { TestRunner } from 'vitest';

// A runner of the user's own, built the way Vitest documents: on its base
// class, calling `super`. It marks what it ran, so a test can tell it was kept.
export default class TheirRunner extends TestRunner {
  override onAfterRunTask(test: Task): void {
    super.onAfterRunTask(test);
    (test.meta as Record<string, unknown>).theirRunner = true;
  }
}
