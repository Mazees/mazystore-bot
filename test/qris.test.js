import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { crc16, validateQris, generateDynamicQris, parseTlv, renderQris } from '../src/qris.js';

const field = (id, value) => `${id}${String(Buffer.byteLength(value)).padStart(2, '0')}${value}`;
const body = field('00','01') + field('01','11') + field('26','0014COM.GO-JEK.WWW') + field('52','5812') + field('53','360') + field('58','ID') + field('59','MZ STORE') + field('60','MOJOKERTO') + '6304';
export const base = body + crc16(body);

test('dynamic QR changes only initiation/amount/CRC and scans to exact payload', async () => {
  const result = generateDynamicQris(base, 180000, 'MZ STORE');
  assert.equal(validateQris(result).merchant, 'MZ STORE');
  const fields = parseTlv(result);
  assert.equal(fields.find(f => f.tag === '54').value, '180000');
  assert.equal(fields.find(f => f.tag === '01').value, '12');
  assert.deepEqual(fields.filter(f => !['01','54','63'].includes(f.tag)), parseTlv(base).filter(f => !['01','63'].includes(f.tag)));
  const { data, info } = await sharp(await renderQris(result)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(jsQR(new Uint8ClampedArray(data), info.width, info.height).data, result);
});

test('reject corrupt checksum, wrong merchant, non-integer and excessive amounts', () => {
  assert.throws(() => validateQris(base.slice(0,-1) + (base.endsWith('0') ? '1' : '0')), /Checksum/);
  assert.throws(() => validateQris(base, 'OTHER MERCHANT'), /merchant/);
  for (const amount of [0, -1, 1.5, NaN, Infinity, 1e12, '20000']) assert.throws(() => generateDynamicQris(base, amount));
});

test('dynamic QR regeneration replaces amount rather than duplicating it', () => {
  const first = generateDynamicQris(base, 21000);
  const second = generateDynamicQris(first, 42000);
  assert.equal(parseTlv(second).filter(f => f.tag === '54').length, 1);
  assert.equal(parseTlv(second).find(f => f.tag === '54').value, '42000');
});
