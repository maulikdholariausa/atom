import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export class InputError extends Error {}

export function fixture(name) {
  return readFileSync(new URL('../fixtures/' + name, import.meta.url), 'utf8');
}

export function jsonLines(text) {
  return text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function webhookEvent(payload) {
  const { order_id: id, order_source: provider, first_name, last_name,
    restaurant, total, items, notes, update, scheduled_at } = payload ?? {};
  if (typeof id !== 'string' || !id.trim() || typeof provider !== 'string' || !provider.trim()
    || !Array.isArray(items) || items.some(item => typeof item !== 'string' || !item.trim())
    || (update !== undefined && !Array.isArray(update))
    || (scheduled_at != null && !Number.isFinite(Date.parse(scheduled_at)))) {
    throw new InputError('Expected order_id, order_source, items and an optional update array.');
  }
  const cancelled = update?.includes('cancelled') ?? false;
  const order = { provider, externalId: id, customer: [first_name, last_name].filter(Boolean).join(' '),
    restaurant, items: items.map(name => ({ name })), notes, total,
    fulfilAt: scheduled_at ? new Date(scheduled_at).toISOString() : null };
  return { source: 'webhook', orderKey: JSON.stringify([provider, id]),
    eventKey: digest([order, update]), cancelled, order };
}

export function pollingEvents(data, checkpoint, stream) {
  const orders = new Map();
  for (const [itemId, item] of Object.entries(data)) {
    if (!item || !['number', 'string'].includes(typeof item.order) || typeof item.name !== 'string'
      || typeof item.status !== 'string' || !Number.isFinite(item.price)
      || (item.scheduled_at != null && !Number.isFinite(Date.parse(item.scheduled_at)))) {
      throw new InputError('Invalid polling order item.');
    }
    const id = String(item.order);
    if (!orders.has(id)) orders.set(id, []);
    orders.get(id).push({ id: itemId, name: item.name, category: item.category, price: item.price,
      status: item.status, scheduledAt: item.scheduled_at ? new Date(item.scheduled_at).toISOString() : undefined });
  }
  return [...orders].map(([id, items]) => ({
    source: 'polling', orderKey: digest([stream, id]), eventKey: digest([stream, checkpoint, id, items]),
    order: { provider: 'Polling API', externalId: id, items }
  }));
}

const csvColumns = ['first_name', 'last_name', 'items', 'notes', 'tomorrow', 'meal'];
const mealHours = { breakfast: 8, lunch: 12, dinner: 18 };

function parseCsv(text) {
  const rows = [];
  const fields = /(?<quoted>"(?:[^"]|"")*")|(?<plain>[^",\r\n]*)/y;
  text = text.replace(/^\uFEFF/, '');
  let row = [];
  let index = 0;
  while (index < text.length) {
    fields.lastIndex = index;
    const match = fields.exec(text);
    const end = fields.lastIndex;
    const separator = text[end];
    if (!match || (separator !== undefined && ![',', '\r', '\n'].includes(separator))) {
      throw new InputError('Malformed CSV near record ' + (rows.length + 1) + '.');
    }
    row.push(match.groups.quoted ? match[0].slice(1, -1).replaceAll('""', '"') : match[0]);
    index = end + (text.slice(end, end + 2) === '\r\n' ? 2 : 1);
    if (separator !== ',') {
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push([...row, '']);
  return rows;
}

export function csvEvents(text, date) {
  const base = new Date(date + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+base)
    || base.toISOString().slice(0, 10) !== date) {
    throw new InputError('Provide an export date in YYYY-MM-DD format.');
  }
  const [header, ...rows] = parseCsv(text);
  if (!header || header.length !== csvColumns.length || csvColumns.some(key => !header.includes(key))) {
    throw new InputError('Expected CSV columns ' + csvColumns.join(', ') + '.');
  }
  const events = [];
  const errors = [];
  const occurrences = new Map();
  for (const [index, row] of rows.entries()) {
    const fields = Object.fromEntries(header.map((key, i) => [key, row[i]?.trim()]));
    const { first_name, last_name, items, notes, tomorrow, meal } = fields;
    const itemNames = items?.split(',').map(name => name.trim()).filter(Boolean);
    if (row.length !== header.length || !first_name || !last_name || !itemNames?.length
      || !['true', 'false'].includes(tomorrow) || !Object.hasOwn(mealHours, meal)) {
      errors.push({ record: index + 2, message: 'Invalid name, items, tomorrow flag, meal, or column count.' });
      continue;
    }
    const due = new Date(base);
    due.setUTCDate(due.getUTCDate() + Number(tomorrow === 'true'));
    due.setUTCHours(mealHours[meal]);
    const order = { provider: 'CSV upload', customer: first_name + ' ' + last_name,
      items: itemNames.map(name => ({ name })), notes, meal, fulfilAt: due.toISOString() };
    const key = digest(order);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    const id = key + ':' + occurrence;
    events.push({ source: 'csv', orderKey: id, eventKey: id, order: { ...order, externalId: id } });
  }
  return { events, errors };
}
