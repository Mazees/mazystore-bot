import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function parseStock(input, batch = false) {
  const blocks = batch ? input.replace(/^\uFEFF/, '').split(/^---\s*$/m) : [input];
  if (!blocks.length || blocks.length > 100) throw new Error('Maksimal 100 unit per batch.');
  return blocks.map((block, index) => {
    const value = block.trim();
    if (!value || value.length > 2000) throw new Error(`Stok bagian ${index + 1} harus 1–2000 karakter. Seluruh batch belum disimpan.`);
    return value;
  });
}

export function encryptStock(value, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptStock(value, key) {
  const data = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), data.subarray(0,12));
  cipher.setAuthTag(data.subarray(12,28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
}

export const available = v => v.delivery_mode === 'auto' ? Number(v.stock_available || 0) : v.ready ? 100 : 0;
export const availability = v => v.delivery_mode === 'auto' ? `Stok: ${available(v)}${available(v) ? '' : ' — Habis'}` : v.ready ? 'Ready' : 'Kosong';
