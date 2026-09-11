import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api.js';
import { createNativeApiClient } from '../src/native.js';

vi.mock('../src/native.js', () => ({ createNativeApiClient: vi.fn(() => null) }));

describe('createApiClient', () => {
  it('reports the calling plugin under the version the packages release at', () => {
    // Plugins name themselves and nothing more: the version comes from this
    // package, which every plugin release pins to its own.
    const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

    createApiClient({
      apiUrl: 'https://api.mergify.com',
      token: 'token',
      repoName: 'Mergifyio/example',
      clientName: '@mergifyio/vitest',
    });

    expect(createNativeApiClient).toHaveBeenCalledWith(
      expect.objectContaining({
        clientName: '@mergifyio/vitest',
        clientVersion: version,
        nodeVersion: process.versions.node,
      })
    );
  });
});
