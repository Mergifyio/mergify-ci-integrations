import { FlakyDetector, isNativeBindingLoaded } from '@mergifyio/ci-core';
import { TestRunner } from 'vitest';
import { extendRunner } from './extend-runner.js';

/**
 * The setup file the reporter injects into Node projects on Vitest 4.1 and
 * later, which export the runner base class from `vitest`.
 */
extendRunner(TestRunner, {
  available: isNativeBindingLoaded,
  create: (context, mode, testNames) => new FlakyDetector(context, mode, testNames),
});
