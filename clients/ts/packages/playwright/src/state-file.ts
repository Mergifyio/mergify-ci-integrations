import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface QuarantineState {
  version: 1;
  testRunId: string;
  createdAt: string;
  rootDir: string;
  quarantinedTests: string[];
}

const CURRENT_VERSION = 1;

export function stateFilePath(cacheRoot: string, testRunId: string): string {
  return join(cacheRoot, '@mergifyio', 'playwright', `state-${testRunId}.json`);
}

export function writeStateFile(path: string, state: QuarantineState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function readStateFile(path: string): QuarantineState | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    process.stderr.write(`[@mergifyio/playwright] failed to read state file ${path}: ${err}\n`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[@mergifyio/playwright] state file ${path} is not valid JSON: ${err}\n`);
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== CURRENT_VERSION
  ) {
    process.stderr.write(
      `[@mergifyio/playwright] state file ${path} has unknown version; treating as absent\n`
    );
    return null;
  }

  if (!isWellFormedState(parsed)) {
    process.stderr.write(
      `[@mergifyio/playwright] state file ${path} has malformed shape; treating as absent\n`
    );
    return null;
  }

  return parsed;
}

/**
 * Validate the load-bearing fields after the version gate. Guards against a
 * partially-written or hand-edited file that still has `version: 1` but is
 * missing / malformed elsewhere — downstream code would otherwise crash on
 * `state.quarantinedTests.length` or `new Set(state.quarantinedTests)`.
 * `testRunId` and `createdAt` are informational and deliberately not
 * validated.
 */
function isWellFormedState(value: object): value is QuarantineState {
  const v = value as Record<string, unknown>;
  return (
    typeof v.rootDir === 'string' &&
    Array.isArray(v.quarantinedTests) &&
    v.quarantinedTests.every((t): t is string => typeof t === 'string')
  );
}
