// One file, three projects: the JSON reporter used to merge these specs across
// projects and report one id for all three copies. Seven tests here means
// fourteen and seven on the two legs, and a listing that reported seven would
// agree with itself while dropping half the run.
import { expect, test } from '@playwright/test';

for (const i of [1, 2, 3, 4, 5, 6, 7]) {
  test(`shared ${i}`, () => {
    expect(i).toBeGreaterThan(0);
  });
}
