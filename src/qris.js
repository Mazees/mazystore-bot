import QRCode from 'qrcode';

export function crc16(text) {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function parseTlv(payload) {
  const bytes = Buffer.from(payload, 'utf8');
  const fields = [];
  for (let offset = 0; offset < bytes.length;) {
    const header = bytes.subarray(offset, offset + 4).toString();
    if (!/^\d{4}$/.test(header)) throw new Error('Header TLV QRIS tidak valid.');
    const length = Number(header.slice(2));
    if (offset + 4 + length > bytes.length) throw new Error('Panjang TLV QRIS tidak valid.');
    const tag = header.slice(0, 2);
    if (fields.some(f => f.tag === tag)) throw new Error('Tag QRIS duplikat.');
    fields.push({ tag, value: bytes.subarray(offset + 4, offset + 4 + length).toString('utf8') });
    offset += 4 + length;
  }
  return fields;
}

const encode = ({ tag, value }) => `${tag}${Buffer.byteLength(value).toString().padStart(2, '0')}${value}`;

export function validateQris(payload, expectedMerchant = '') {
  const fields = parseTlv(payload.trim());
  const get = tag => fields.find(f => f.tag === tag)?.value;
  if (fields.at(-1)?.tag !== '63' || !/^[0-9A-F]{4}$/i.test(get('63') ?? '')) throw new Error('CRC QRIS tidak ditemukan.');
  if (crc16(payload.trim().slice(0, -4)) !== get('63').toUpperCase()) throw new Error('Checksum QRIS tidak cocok.');
  if (get('00') !== '01' || get('53') !== '360' || get('58') !== 'ID' || !['11', '12'].includes(get('01'))) throw new Error('Payload bukan QRIS IDR yang didukung.');
  if (!get('59') || (expectedMerchant && !get('59').toUpperCase().includes(expectedMerchant.toUpperCase()))) throw new Error('Nama merchant QRIS tidak sesuai.');
  if (fields.some(f => ['55', '56', '57'].includes(f.tag))) throw new Error('QRIS dengan biaya/tip tambahan belum didukung.');
  return { fields, merchant: get('59'), city: get('60') ?? '' };
}

export function generateDynamicQris(base, amount, expectedMerchant = '') {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999999999999) throw new Error('Nominal QRIS tidak valid.');
  const { fields } = validateQris(base, expectedMerchant);
  const output = fields.filter(f => !['54', '63'].includes(f.tag)).map(f => f.tag === '01' ? { tag: '01', value: '12' } : f);
  output.splice(output.findIndex(f => f.tag === '53') + 1, 0, { tag: '54', value: String(amount) });
  const body = output.map(encode).join('') + '6304';
  return body + crc16(body);
}

export function renderQris(payload) {
  return QRCode.toBuffer(payload, { type: 'png', width: 900, margin: 4, errorCorrectionLevel: 'M' });
}
