import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@mergifyio/playwright';

test('passes', () => {
  expect(1).toBe(1);
});

test('flaky-test', () => {
  // Counter persisted via FLAKY_COUNTER_PATH env var. First call fails,
  // every subsequent call passes. The integration runner sets a fresh
  // path per `spawnSync` invocation.
  const path = process.env.FLAKY_COUNTER_PATH;
  if (!path) throw new Error('FLAKY_COUNTER_PATH not set');
  const count = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
  writeFileSync(path, String(count + 1));
  if (count === 0) {
    expect.fail('first call always fails');
  }
});
