import { describe, expect, it } from 'vitest';
import { detect } from '../../src/resources/vitest.js';

describe('Vitest resource detector', () => {
  it('returns framework name and version', () => {
    const attrs = detect('4.1.2');
    expect(attrs).toEqual({
      'test.framework': 'vitest',
      'test.framework.version': '4.1.2',
    });
  });
});
