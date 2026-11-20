import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCents, formatCents } from '../server/money.js';

test('decimal strings parse to exact integer cents', () => {
  assert.equal(parseCents('0.00'), 0);
  assert.equal(parseCents('1280.00'), 128000);
  assert.equal(parseCents('0.07'), 7);
  assert.equal(parseCents('0.1'), 10);
  assert.equal(parseCents(' 1,234.56 '), 123456);
  assert.equal(parseCents('999999999.99'), 99999999999);
  assert.equal(parseCents('-12.30'), -1230);
  assert.equal(parseCents(12.3), 1230);
});

test('amounts that do not fit cents are refused rather than rounded', () => {
  assert.throws(() => parseCents('1.005'), /Invalid money value/);
  assert.throws(() => parseCents('1.2399'), /Invalid money value/);
  assert.equal(parseCents('1.2300'), 123, 'trailing zeros past the cent are harmless');
});

test('malformed amounts are refused', () => {
  for (const bad of ['', 'ten', '1.2.3', '1e3', '¥12.00', null, undefined, {}, NaN, Infinity]) {
    assert.throws(() => parseCents(bad), /Invalid money value/, `should reject ${String(bad)}`);
  }
});

test('formatting round-trips through parseCents', () => {
  for (const cents of [0, 7, 1230, -1230, 99999999999]) {
    assert.equal(parseCents(formatCents(cents)), cents);
  }
  assert.equal(formatCents(-5), '-0.05');
});
