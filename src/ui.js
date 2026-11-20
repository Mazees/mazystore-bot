const segmenter = new Intl.Segmenter('id', { granularity: 'grapheme' });
export const GRID_WIDTH = 28;
const graphemes = text => Array.from(segmenter.segment(String(text)), item => item.segment);
const safe = text => String(text).replace(/`/g, 'ʼ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\t/g, '  ');

export function textWidth(value) {
  return graphemes(value).reduce((sum, part) => {
    if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(part)) return sum;
    const cp = part.codePointAt(0);
    const wide = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(part) || cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2329 && cp <= 0x232a || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6 || cp >= 0x20000 && cp <= 0x3fffd);
    return sum + (wide ? 2 : 1);
  }, 0);
}

export function wrapText(value, width = GRID_WIDTH - 2) {
  const output = [];
  for (const original of safe(value).split('\n')) {
    if (!original.trim()) { output.push(''); continue; }
    let line = '';
    for (const word of original.trim().split(/\s+/)) {
      if (line && textWidth(line + ' ' + word) <= width) { line += ' ' + word; continue; }
      if (line) { output.push(line); line = ''; }
      for (const part of graphemes(word)) {
        if (textWidth(line + part) > width) { output.push(line); line = ''; }
        line += part;
      }
    }
    output.push(line);
  }
  return output;
}

export function grid(title, sections = [], width = GRID_WIDTH) {
  const groups = [title, ...sections].filter(section => section !== '' && section !== undefined && section !== null);
  const row = line => line ? `│ ${line}` : '│';
  const lines = [`┌${'─'.repeat(width)}`];
  groups.forEach((section, index) => {
    if (index) lines.push(`├${'─'.repeat(width)}`);
    lines.push(...wrapText(section, width - 2).map(row));
  });
  lines.push(`└${'─'.repeat(width)}`);
  return '```\n' + lines.join('\n') + '\n```';
}

export const numbered = choices => choices.map((choice, i) => `${i + 1}. ${typeof choice === 'string' ? choice : choice.label}`).join('\n');

// Keep each WhatsApp chunk independently fenced; do not split a grid or a link across sends.
export function splitMessage(text, limit = 4000) {
  if (Array.from(text).length <= limit) return [text];
  const framed = text.match(/^```\n(┌─+┐?)\n([\s\S]*)\n(└─+┘?)\n```([\s\S]*)$/);
  if (framed) {
    const [, top, content, bottom, tail] = framed;
    const pack = rows => '```\n' + [top, ...rows, bottom].join('\n') + '\n```';
    const chunks = [];
    let rows = [];
    for (const line of content.split('\n')) {
      if (rows.length && Array.from(pack([...rows, line])).length > limit) { chunks.push(pack(rows)); rows = []; }
      rows.push(line);
    }
    if (rows.length) chunks.push(pack(rows));
    if (tail.trim()) {
      if (Array.from(chunks.at(-1) + tail).length <= limit) chunks[chunks.length - 1] += tail;
      else chunks.push(...splitMessage(tail.trim(), limit));
    }
    return chunks;
  }
  const chunks = [];
  let buffer = '';
  let fenced = false;
  for (const line of text.split('\n')) {
    const next = buffer ? buffer + '\n' + line : line;
    if (Array.from(next).length + (fenced ? 4 : 0) > limit && buffer) {
      chunks.push(buffer + (fenced ? '\n```' : ''));
      buffer = (fenced ? '```\n' : '') + line;
    } else buffer = next;
    if (line === '```') fenced = !fenced;
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}
