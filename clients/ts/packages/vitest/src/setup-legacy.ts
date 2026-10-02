import { FlakyDetector, isNativeBindingLoaded } from '@mergifyio/ci-core';
import { VitestTestRunner } from 'vitest/runners';
import { extendRunner } from './extend-runner.js';

/**
 * The setup file the reporter injects into Node projects before Vitest 4.1,
 * which export the runner base class only from `vitest/runners` — a subpath
 * 4.1 deprecates and 5.0 removed, hence a separate file.
 */
extendRunner(VitestTestRunner, {
  available: isNativeBindingLoaded,
  create: (context, mode, testNames) => new FlakyDetector(context, mode, testNames),
});
