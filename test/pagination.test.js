import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastPageOffset, pageOffset } from '../public/pagination.js';

test('last page handles empty, single-page, exact, and partial counts', () => {
  assert.equal(lastPageOffset(0, 25), 0);
  assert.equal(lastPageOffset(8, 25), 0);
  assert.equal(lastPageOffset(50, 25), 25);
  assert.equal(lastPageOffset(51, 25), 50);
  assert.equal(lastPageOffset(51, 10), 50);
  assert.equal(lastPageOffset(51, 100), 0);
});

test('navigation jumps to first and last and stays within the result set', () => {
  assert.equal(pageOffset('first', 50, 25, 61), 0);
  assert.equal(pageOffset('last', 0, 25, 61), 50);
  assert.equal(pageOffset('prev', 50, 25, 61), 25);
  assert.equal(pageOffset('prev', 0, 25, 61), 0);
  assert.equal(pageOffset('next', 25, 25, 61), 50);
  assert.equal(pageOffset('next', 50, 25, 61), 50);
  assert.equal(pageOffset('next', 0, 25, 0), 0);
});
