import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fixture, webhookEvent } from '../src/inputs.js';
import { start } from '../src/server.js';

async function until(check, ms = 12000) {
  const deadline = Date.now() + ms;
  do {
    const value = await check();
    if (value) return value;
    await sleep(30);
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for expected state');
}

function client(app) {
  return async (path, options, status = 200) => {
    const response = await fetch(app.url + path, { ...options, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, status, path);
    return response.json();
  };
}

test('orders API respects page size, offset, and filtered totals', async t => {
  const app = await start({ port: 0, database: ':memory:' });
  t.after(() => app.close());
  const call = client(app);
  const script = await fetch(app.url + '/pagination.js');
  assert.equal(script.status, 200);
  assert.match(await script.text(), /lastPageOffset/);
  await call('/api/import/csv?date=2099-12-01',
    { method: 'POST', body: fixture('orders_1.csv') }, 202);
  await until(() => app.store.orders('', 'csv', 1, 0).count === 75);
  const route = '/api/orders?source=csv&status=scheduled';
  const first = await call(route + '&limit=10&offset=0');
  const last = await call(route + '&limit=10&offset=70');
  const large = await call(route + '&limit=100');
  assert.equal(first.count, 75);
  assert.equal(last.count, 75);
  assert.equal(large.orders.length, 75);
  assert.deepEqual(first.orders, large.orders.slice(0, 10));
  assert.deepEqual(last.orders, large.orders.slice(70));
  assert.equal(last.orders.length, 5);
  assert.deepEqual(await call(route + '&offset=75'), { count: 75, orders: [] });
  assert.deepEqual(await call('/api/orders?source=webhook'), { count: 0, orders: [] });
  await call(route + '&limit=101', undefined, 400);
  await call(route + '&offset=-1', undefined, 400);
});

test('the demo ingests all fixtures, deduplicates repeat uploads, and exposes history', async t => {
  const app = await start({ port: 0, database: ':memory:', robotReplyDelay: () => 0 });
  t.after(() => app.close());
  const call = client(app);
  const ui = await fetch(app.url);
  assert.match(await ui.text(), /Run demo/);
  await call('/api/demo', { method: 'POST' }, 202);
  const status = await until(async () => {
    const stats = await call('/api/status');
    assert.notEqual(stats.demo.phase, 'failed', stats.demo.error);
    return stats.demo.phase === 'complete' && stats;
  });
  assert.equal(status.demo.pollError, 'Polling API returned HTTP 500');
  assert.deepEqual(status.demo.csv.map(report => report.added), [75, 39, 75, 78]);
  assert.deepEqual(status.demo.csv.map(report => report.errors.length), [0, 0, 0, 0]);
  const orderCount = async source => (await call('/api/orders?source=' + source)).count;
  assert.equal(await orderCount('webhook'), 999);
  assert.equal(await orderCount('polling'), 60);
  assert.equal(await orderCount('csv'), 267);
  assert.equal((await call('/api/orders?source=webhook&status=order_review')).count, 2);
  const date = app.store.checkpoint('demo-date');
  const repeat = await call('/api/import/csv?date=' + date,
    { method: 'POST', body: fixture('orders_4.csv') }, 202);
  assert.deepEqual(repeat, { added: 0, duplicate: 267, errors: [] });
  const { orders } = await call('/api/orders?source=webhook&status=cancelled');
  assert.equal(orders.length, 2);
  const timeline = await call('/api/orders/' + orders[0].id + '/events');
  assert.deepEqual(timeline.map(event => event.kind), ['created', 'cancelled']);
  const future = await call('/api/orders?status=scheduled&source=csv');
  assert.ok(future.count > 0);

  const reset = confirmation => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation })
  });
  await call('/api/reset', reset('Clear'), 400);
  assert.equal(await orderCount('csv'), 267);
  assert.equal((await call('/api/status')).canClearDatabase, false);
  await call('/api/reset', reset('clear'), 409);
  await until(async () => (await call('/api/status')).canClearDatabase, 20_000);
  await call('/api/reset', reset('clear'));
  assert.equal((await call('/api/orders')).count, 0);
  assert.equal((await call('/api/status')).demo.phase, 'idle');
  assert.equal(app.store.checkpoint('demo'), undefined);
  assert.equal(app.store.mockJobCount(), 0);
  const importedAgain = await call('/api/import/csv?date=' + date,
    { method: 'POST', body: fixture('orders_1.csv') }, 202);
  assert.equal(importedAgain.added, 75);
});

test('dispatch retries on the same robot after a lost acknowledgement', async t => {
  const app = await start({ port: 0, database: ':memory:' });
  t.after(() => app.close());
  const call = client(app);
  const order = { order_id: 'a', order_source: 'test', items: ['Sandwich'] };
  const opts = { method: 'POST', body: JSON.stringify(order) };
  assert.equal((await call('/webhooks/orders', opts, 202)).queued, true);
  assert.equal((await call('/webhooks/orders', opts, 202)).queued, false);
  await until(() => app.store.getOrder(1)?.status === 'dispatch_pending');
  app.store.enqueue(['b', 'c', 'd'].map(id => webhookEvent({ ...order, order_id: id })));
  await until(() => [2, 3, 4].every(id => app.store.getOrder(id)?.status === 'dispatched'));
  assert.deepEqual([2, 3, 4].map(id => app.store.history(id).at(-1).detail.robot),
    ['robot-b', 'robot-c', 'robot-d']);
  await until(() => app.store.getOrder(1)?.status === 'dispatched');
  const timeline = await call('/api/orders/1/events');
  assert.deepEqual(timeline.map(event => event.kind), ['created', 'dispatch_assigned', 'dispatch_retry', 'dispatched']);
  assert.equal(new Set(timeline.slice(1).map(event => event.detail.dispatchId)).size, 1);
  assert.equal(new Set(timeline.slice(1).map(event => event.detail.robot)).size, 1);
  assert.equal(app.store.mockJobCount(), 4);
});

test('a polling failure preserves its checkpoint and a restart resumes from the committed checkpoint', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'order-test-'));
  const database = join(dir, 'orders.sqlite');
  const cursors = [];
  const provider = createServer((req, res) => {
    const cursor = new URL(req.url, 'http://localhost').searchParams.get('time_since');
    cursors.push(cursor);
    const response = cursors.length === 1 ? 500 : 200;
    res.writeHead(response, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      response, next_checkpoint: 'next', data: { line: { order: 42, name: 'Salad', price: 3,
        status: 'ordered', scheduled_at: '2099-12-31T12:00:00Z' } }
    }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const endpoint = 'http://127.0.0.1:' + provider.address().port + '/orders';
  let app;
  t.after(async () => {
    await app?.close();
    await new Promise(resolve => provider.close(resolve));
    await rm(dir, { recursive: true });
  });
  const options = { port: 0, database, ordersApiUrl: endpoint, pollMs: 75 };
  app = await start(options);
  await until(() => app.store.checkpoint(endpoint) === 'next' && app.store.getOrder(1));
  assert.equal(cursors[0], cursors[1]);
  assert.equal(app.store.getOrder(1).status, 'scheduled');
  await app.close();
  app = undefined;
  const before = cursors.length;
  app = await start(options);
  await until(() => cursors.length > before);
  assert.equal(cursors[before], 'next');
  assert.equal(app.store.history(1).length, 1);
});
