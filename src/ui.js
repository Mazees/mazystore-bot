const clean = value => String(value).replace(/`/g, 'ʼ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\t/g, '  ').split('\n').map(line => line.trimEnd()).join('\n').trim();
const bold = value => `*${clean(value).replace(/\*/g, '')}*`;

export function renderMessage(title, sections = []) {
  const body = sections.filter(value => value !== undefined && value !== null).map(clean).filter(Boolean);
  const header = `┏━━━━━━━━━━━━━━━━━━━┓\n┃  ${bold(clean(title).replaceAll(' · ', ' | '))}\n┗━━━━━━━━━━━━━━━━━━━┛`;
  return header + (body.length ? '\n\n' + body.join('\n\n────────────────────\n\n') : '');
}

export const numbered = choices => choices.map((choice, i) => {
  const [title, ...details] = clean(typeof choice === 'string' ? choice : choice.label).split('\n');
  const label = bold(`${String(i + 1).padStart(2, '0')} | ${title}`);
  if (!details.length) return `${i === choices.length - 1 ? '└' : '├'}  ${label}`;
  return [`┌  ${label}`, ...details.map((line, index) => `${index === details.length - 1 ? '└' : '│'}  ${line}`)].join('\n');
}).join('\n\n');

// Keep titles, links, and ordinary words together across WhatsApp messages.
export function splitMessage(text, limit = 4000) {
  if (Array.from(text).length <= limit) return [text];
  const chunks = [];
  let buffer = '';
  let size = 0;
  for (const token of text.match(/\*[^\n*]+\*|https?:\/\/\S+|\s+|[^\s*]+|\*/gu) || []) {
    const chars = Array.from(token);
    if (size + chars.length > limit && buffer) {
      if (buffer.trim()) chunks.push(buffer.trim());
      buffer = ''; size = 0;
    }
    if (chars.length > limit) {
      if (/^https?:\/\//.test(token)) throw new Error('Link melebihi batas panjang pesan WhatsApp.');
      while (chars.length > limit) chunks.push(chars.splice(0, limit).join(''));
    }
    const rest = chars.join('');
    buffer += size ? rest : rest.trimStart();
    size = Array.from(buffer).length;
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}
