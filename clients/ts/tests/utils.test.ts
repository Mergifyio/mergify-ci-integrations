import { describe, expect, it } from 'vitest';
import { strtobool } from '../src/utils.js';

describe('strtobool', () => {
  it.each(['y', 'Y', 'yes', 'YES', 'Yes', 't', 'T', 'true', 'TRUE', 'True', 'on', 'ON', '1'])(
    'returns true for "%s"',
    (value) => {
      expect(strtobool(value)).toBe(true);
    }
  );

  it.each(['n', 'N', 'no', 'NO', 'No', 'f', 'F', 'false', 'FALSE', 'False', 'off', 'OFF', '0'])(
    'returns false for "%s"',
    (value) => {
      expect(strtobool(value)).toBe(false);
    }
  );

  it.each(['', 'anything', '42', 'yesno'])('throws for unrecognized value "%s"', (value) => {
    expect(() => strtobool(value)).toThrow(`Could not convert '${value}' to boolean`);
  });
});
