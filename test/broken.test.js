import test from 'node:test';
import assert from 'node:assert/strict';

// Deliberately broken: the review worker must report adabra/tests as failed for this PR.
test('payment total includes tax', () => {
  const total = 100 + 100 * 0.2;
  assert.equal(total, 125, 'expected tax to be 25%');
});
