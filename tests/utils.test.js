import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, isValidISODate, validMonth, kyivParts, parseBotDate, splitTelegramText } from '../src/utils.js';

test('validates actual calendar dates and leap years', () => {
  assert.equal(isValidISODate('2028-02-29'),true);
  assert.equal(isValidISODate('2026-02-29'),false);
  assert.equal(isValidISODate('2026-13-01'),false);
  assert.equal(validMonth('2026-11'),true);
  assert.equal(validMonth('2026-13'),false);
});
test('tomorrow crosses months and years', () => {
  assert.equal(addDays('2026-11-30',1),'2026-12-01');
  assert.equal(addDays('2026-12-31',1),'2027-01-01');
});
test('recognizes date in bot commands', () => {
  assert.equal(parseBotDate('24.11','2026-11-20'),'2026-11-24');
  assert.equal(parseBotDate('01.01.2027','2026-11-20'),'2027-01-01');
  assert.equal(parseBotDate('31.02','2026-11-20'),null);
});
test('Kyiv hour shifts correctly across daylight savings', () => {
  assert.deepEqual(kyivParts(new Date('2026-01-15T16:00:00Z')),{date:'2026-01-15',hour:18});
  assert.deepEqual(kyivParts(new Date('2026-07-15T15:00:00Z')),{date:'2026-07-15',hour:18});
});
test('telegram output chunks fit into API limits', () => {
  const s=Array(1500).fill('Some very long Telegram line').join('\n');
  const parts=splitTelegramText(s);
  assert.ok(parts.length > 2);
  assert.ok(parts.every(t=>t.length<=3600));
});
