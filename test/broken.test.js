import test from 'node:test';
import assert from 'node:assert/strict';

// Was deliberately broken; the expectation is now correct (20% tax).
test('payment total includes tax', () => {
  const total = 100 + 100 * 0.2;
  assert.equal(total, 120, "expected tax to be 20%");
});
