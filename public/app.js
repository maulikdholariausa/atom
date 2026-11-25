import { lastPageOffset, pageOffset } from './pagination.js';

const byId = id => document.getElementById(id);
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'
});
const label = value => value === 'csv' ? 'CSV' : value === 'polling' ? 'Polling API'
  : value.replaceAll('_', ' ').replace(/^./, char => char.toUpperCase());
const date = value => value ? dateFormat.format(new Date(value)) : '—';
const rows = byId('orders');
const countFormat = new Intl.NumberFormat();
let pageSize = Number(byId('page-size').value);
let matchingCount = 0;
let offset = 0;
let refreshVersion = 0;
let openOrder;
let renderSignature;
let detailSignature;
let resetPending = false;
let resetNotice = false;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

function notice(message) {
  const output = byId('notice');
  output.textContent = message;
  output.hidden = !message;
}

function renderOrders(data) {
  matchingCount = data.count;
  byId('matching-count').textContent = '(' + countFormat.format(data.count) + ')';
  const signature = JSON.stringify(data);
  if (renderSignature !== signature) {
    const focused = document.activeElement?.dataset.orderId;
    rows.replaceChildren(...data.orders.map(order => {
      const link = node('button', '#' + order.id, 'link');
      link.dataset.orderId = order.id;
      link.addEventListener('click', () => showOrder(order.id));
      const status = node('span', label(order.status), 'badge');
      status.dataset.status = order.status;
      const row = node('tr');
      for (const value of [link, order.details.customer || order.details.externalId,
        label(order.source), status, date(order.fulfil_at)]) {
        const cell = node('td');
        cell.append(value);
        row.append(cell);
      }
      return row;
    }));
    if (!data.orders.length) {
      const row = node('tr');
      const cell = node('td', 'No orders match these filters.', 'empty');
      cell.colSpan = 5;
      row.append(cell);
      rows.append(row);
    }
    if (focused) rows.querySelector('[data-order-id="' + focused + '"]')?.focus();
    renderSignature = signature;
  }
  byId('range').textContent = data.count
    ? (offset + 1) + '–' + (offset + data.orders.length) + ' of ' + data.count
    : '0 orders';
  byId('first').disabled = byId('prev').disabled = offset === 0;
  byId('last').disabled = byId('next').disabled = offset >= lastPageOffset(data.count, pageSize);
}

async function showOrder(id) {
  const dialog = byId('detail');
  if (!dialog.open) {
    byId('detail-body').textContent = 'Loading…';
    dialog.showModal();
  }
  openOrder = id;
  try {
    const [order, events] = await Promise.all([
      api('/api/orders/' + id), api('/api/orders/' + id + '/events')
    ]);
    if (openOrder !== id) return;
    const signature = JSON.stringify([order, events]);
    if (signature === detailSignature) return;
    detailSignature = signature;
    byId('detail-title').textContent = 'Order #' + id;
    const terms = node('dl');
    for (const [term, value] of Object.entries({
      Status: label(order.status),
      Customer: order.details.customer,
      Provider: order.details.provider,
      Reference: order.source !== 'csv' ? order.details.externalId : null,
      Total: Number.isFinite(order.details.total) ? order.details.total.toFixed(2) : null,
      Restaurant: order.details.restaurant,
      Scheduled: date(order.fulfil_at),
      Notes: order.details.notes
    })) {
      if (value) terms.append(node('dt', term), node('dd', value));
    }
    const items = node('ul');
    for (const item of order.details.items) {
      items.append(node('li', item.name + (item.status ? ' · ' + label(item.status) : '')));
    }
    const timeline = node('ol');
    for (const event of events) {
      const item = node('li');
      const robot = event.detail.robot ? ' · ' + event.detail.robot : '';
      item.append(node('strong', label(event.kind) + robot), node('br'), node('time', date(event.at) + ' UTC'));
      if (event.detail.error) item.append(node('p', event.detail.error));
      timeline.append(item);
    }
    byId('detail-body').replaceChildren(terms, node('h3', 'Items'), items, node('h3', 'History'), timeline);
  } catch (error) {
    if (openOrder === id) byId('detail-body').textContent = error.message;
  }
}

async function refresh() {
  const version = ++refreshVersion;
  const params = new URLSearchParams({
    source: byId('source').value, status: byId('status').value, limit: pageSize, offset
  });
  try {
    const [data, stats] = await Promise.all([api('/api/orders?' + params), api('/api/status')]);
    if (version !== refreshVersion) return;
    if (offset && offset >= data.count) {
      offset = lastPageOffset(data.count, pageSize);
      return refresh();
    }
    renderOrders(data);
    const sum = status => stats.orders.filter(row => !status || row.status === status)
      .reduce((total, row) => total + row.count, 0);
    for (const [id, value] of Object.entries({
      total: sum(), scheduled: sum('scheduled'), dispatched: sum('dispatched'), queued: stats.queued,
      'ready-count': sum('ready'),
      'dispatch-pending-count': sum('dispatch_pending'),
      'cancelled-count': sum('cancelled'),
      'external-count': sum('external_fulfilled'),
      'order-review-count': sum('order_review'),
      'dispatch-review-count': sum('dispatch_review'),
      'inbox-failed-count': stats.failed
    })) byId(id).textContent = countFormat.format(value);
    const { demo } = stats;
    byId('demo').disabled = resetPending || demo.phase === 'running';
    byId('open-reset').disabled = resetPending || demo.phase === 'running';
    if (demo.phase === 'running') notice('Demo running. Polling: ' + demo.polling + '.');
    else if (demo.phase === 'failed') notice('Demo failed: ' + demo.error);
    else if (stats.failed) notice(stats.failed + ' inbox events need review.');
    else if (demo.phase === 'complete') notice('Demo imported webhook, polling, and CSV data. Due orders are dispatched in the background.');
    else notice(resetNotice ? 'Database cleared.' : '');
    if (openOrder) await showOrder(openOrder);
  } catch (error) {
    if (version === refreshVersion) notice(error.message);
  }
}

for (const button of document.querySelectorAll('[data-help]')) {
  button.addEventListener('click', () => byId(button.dataset.help).showModal());
}
for (const id of ['status', 'source']) byId(id).addEventListener('change', () => { offset = 0; refresh(); });
byId('page-size').addEventListener('change', event => {
  pageSize = Number(event.target.value);
  offset = 0;
  refresh();
});
for (const action of ['first', 'prev', 'next', 'last']) {
  byId(action).addEventListener('click', () => {
    offset = pageOffset(action, offset, pageSize, matchingCount);
    refresh();
  });
}
byId('detail').addEventListener('close', () => { openOrder = undefined; detailSignature = undefined; });
byId('demo').addEventListener('click', async () => {
  resetNotice = false;
  byId('demo').disabled = true;
  try {
    await api('/api/demo', { method: 'POST' });
    await refresh();
  } catch (error) {
    notice(error.message);
    byId('demo').disabled = false;
  }
});

byId('date').value = new Date().toISOString().slice(0, 10);
byId('open-import').addEventListener('click', () => byId('import').showModal());
byId('upload').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  const output = byId('import-result');
  try {
    const report = await api('/api/import/csv?date=' + encodeURIComponent(byId('date').value), {
      method: 'POST', body: byId('file').files[0]
    });
    output.textContent = report.added + ' queued, ' + report.duplicate + ' already imported, '
      + report.errors.length + ' invalid.';
    if (report.errors.length) output.append(' Invalid records: ' + report.errors.map(row => row.record).join(', ') + '.');
    await refresh();
  } catch (error) {
    output.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

const resetDialog = byId('reset');
const resetForm = byId('reset-form');
const confirmation = byId('reset-confirmation');
const confirmReset = byId('confirm-reset');
const cancelReset = byId('cancel-reset');
const resetError = byId('reset-error');

byId('open-reset').addEventListener('click', () => {
  resetForm.reset();
  resetError.hidden = true;
  confirmReset.disabled = true;
  resetDialog.showModal();
  confirmation.focus();
});
confirmation.addEventListener('input', () => {
  confirmReset.disabled = confirmation.value !== 'clear';
  resetError.hidden = true;
});
cancelReset.addEventListener('click', () => resetDialog.close());
resetDialog.addEventListener('cancel', event => {
  if (resetPending) event.preventDefault();
});
resetForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (resetPending || confirmation.value !== 'clear') return;
  resetPending = true;
  confirmReset.disabled = cancelReset.disabled = confirmation.disabled = true;
  try {
    await api('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: confirmation.value })
    });
    resetNotice = true;
    offset = 0;
    resetDialog.close();
  } catch (error) {
    resetError.textContent = error.message;
    resetError.hidden = false;
  } finally {
    resetPending = false;
    confirmReset.disabled = cancelReset.disabled = confirmation.disabled = false;
    await refresh();
  }
});

await refresh();
setInterval(refresh, 1000);
