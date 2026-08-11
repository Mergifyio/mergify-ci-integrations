import { createRequire } from 'node:module';

/**
 * This plugin's own version, reported to the backend in the `User-Agent` so it
 * can count who runs which client. Read from the installed package.json rather
 * than baked in as a constant: the published version is stamped at release
 * time, and the checked-in one is a `0.0.0` placeholder.
 *
 * `../package.json` resolves the same from `src/` and the bundled `dist/` —
 * both sit one level below the package root.
 */
export function readPluginVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
