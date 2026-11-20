import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { validateQris } from '../src/qris.js';

const file = process.argv[2];
if (!file) throw new Error('Pemakaian: npm run qris:import -- path/qris.jpg [output.txt]');
const input = await readFile(file);
const { data, info } = await sharp(input, { limitInputPixels: 25000000 }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'attemptBoth' });
if (!code) throw new Error('QR tidak terbaca. Gunakan gambar asli dengan resolusi lebih tinggi.');
const { merchant, city } = validateQris(code.data);
const output = resolve(process.argv[3] || 'config/qris.txt');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, code.data + '\n', { mode: 0o600, flag: 'wx' });
console.log(`QRIS valid: ${merchant}, ${city}. Payload disimpan ke ${output}.`);

