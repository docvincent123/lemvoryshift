export const KYIV_TZ = 'Europe/Kyiv';

export function isValidISODate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const dt = new Date(`${v}T12:00:00Z`);
  return Number.isFinite(dt.valueOf()) && dt.toISOString().slice(0, 10) === v;
}

export function validMonth(v) {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

export function addDays(isoDate, amount) {
  if (!isValidISODate(isoDate)) throw new Error('Некоректна дата');
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

export function kyivParts(when = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: KYIV_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23'
  });
  const p = Object.fromEntries(f.formatToParts(when).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

export function prettyDate(isoDate) {
  if (!isValidISODate(isoDate)) return isoDate;
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}

export function parseBotDate(value, base) {
  if (!value) return base;
  if (isValidISODate(value)) return value;
  if (/^\d{1,2}\.\d{1,2}(\.\d{4})?$/.test(value)) {
    const [d, m, yr] = value.split('.');
    const full = `${yr ?? base.slice(0, 4)}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    if (isValidISODate(full)) return full;
  }
  return null;
}

export function splitTelegramText(message, max = 3600) {
  if (message.length <= max) return [message];
  const chunks = [];
  let current = '';
  for (const line of message.split('\n')) {
    if (current && `${current}\n${line}`.length > max) {
      chunks.push(current);
      current = '';
    }
    if (line.length > max) {
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
    } else {
      current += current ? `\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Normalize Ukrainian mobile numbers to E.164; never use a phone as proof of ownership by itself.
export function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[\s().-]/g, '');
  if (/^0\d{9}$/.test(digits)) return `+38${digits}`;
  if (/^380\d{9}$/.test(digits)) return `+${digits}`;
  if (/^\+380\d{9}$/.test(digits)) return digits;
  return null;
}
