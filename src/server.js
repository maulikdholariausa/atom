import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { openStore } from './store.js';
import { InputError, csvEvents, fixture, jsonLines, pollingEvents, webhookEvent } from './inputs.js';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/pagination.js', ['pagination.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']]
]);
const today = () => new Date().toISOString().slice(0, 10);
const robots = ['robot-a', 'robot-b'];
const MAX_REQUEST_BODY_BYTES = 2_000_000;
const orderIdRoute = /^\/api\/orders\/([1-9]\d*)(\/events)?$/;

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      req.resume();
      throw new InputError(`Request exceeds the ${MAX_REQUEST_BODY_BYTES / 1_000_000} MB limit.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch (error) {
    if (error instanceof SyntaxError) throw new InputError('Expected a JSON request body.');
    throw error;
  }
}

function step(event) {
  return JSON.stringify([event.order_source, event.order_id]);
}

export async function start({
  port = 3000, host = '127.0.0.1', database = 'data/orders.sqlite',
  ordersApiUrl, ordersApiToken, pollMs = 5000, dropFirstRobotReply = true
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  if (!Number.isFinite(pollMs) || pollMs < 50) throw new Error('Polling interval must be at least 50 ms.');
  if (ordersApiUrl && !['https:', 'http:'].includes(new URL(ordersApiUrl).protocol)) {
    throw new Error('ORDERS_API_URL must be an HTTP or HTTPS URL.');
  }
  const responses = jsonLines(fixture('api_responses.jsonl'));
  const webhooks = jsonLines(fixture('webhook_orders.jsonl'));
  if (database !== ':memory:') mkdirSync(dirname(resolve(database)), { recursive: true });
  const store = openStore(database);
  const stop = new AbortController();
  const initialDemo = () => ({ phase: 'idle', polling: 'idle', pollError: null, error: null, csv: [] });
  const demo = initialDemo();
  let clearing = false;
  const activeWrites = new Set();

  async function trackWrite(work) {
    const operation = work();
    activeWrites.add(operation);
    try {
      return await operation;
    } finally {
      activeWrites.delete(operation);
    }
  }
  let demoJob;
  let baseUrl;
  const tasks = [];

  const request = (url, options = {}) => fetch(url, {
    ...options, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(3000)])
  });

  async function importCsv(text, date) {
    const { events, errors } = csvEvents(text, date);
    let added = 0;
    for (let index = 0; index < events.length; index += 50) {
      added += store.enqueue(events.slice(index, index + 50));
      await sleep(0, undefined, { signal: stop.signal });
    }
    return { added, duplicate: events.length - added, errors };
  }

  async function poll(endpoint, stream, token) {
    const checkpoint = store.checkpoint(stream) ?? (stream === 'demo' ? '0' : '1970-01-01T00:00:00.000Z');
    const url = new URL(endpoint);
    url.searchParams.set('time_since', checkpoint);
    const response = await request(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    if (!response.ok) throw new Error('Polling API returned HTTP ' + response.status);
    const body = await response.json();
    if (body.response !== 200 || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)
      || typeof body.next_checkpoint !== 'string' || !body.next_checkpoint) {
      throw new Error('Polling API returned an invalid response.');
    }
    store.enqueue(pollingEvents(body.data, body.next_checkpoint, stream), { stream, value: body.next_checkpoint });
    return body.done === true;
  }

  async function pollDemo() {
    demo.polling = 'running';
    let failures = 0;
    while (!stop.signal.aborted) {
      try {
        const done = await poll(baseUrl + '/mock/orders', 'demo');
        failures = 0;
        if (done) {
          demo.polling = 'complete';
          return;
        }
      } catch (error) {
        demo.pollError = error.message;
        if (++failures >= 5) {
          demo.polling = 'failed';
          throw error;
        }
      }
      await sleep(failures ? 120 * failures : 35, undefined, { signal: stop.signal });
    }
  }

  async function replayWebhooks() {
    const orders = new Map();
    for (const payload of webhooks) {
      const key = step(payload);
      if (!orders.has(key)) orders.set(key, []);
      orders.get(key).push(payload);
    }
    const groups = [...orders.values()];
    for (let index = 0; index < groups.length; index += 20) {
      await Promise.all(groups.slice(index, index + 20).map(async group => {
        for (const payload of group) {
          const result = await request(baseUrl + '/webhooks/orders', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
          });
          if (!result.ok) throw new Error('Webhook replay returned HTTP ' + result.status);
          await result.json();
        }
      }));
      await sleep(10, undefined, { signal: stop.signal });
    }
  }

  async function runDemo(date) {
    const result = await Promise.allSettled([pollDemo(), replayWebhooks(), (async () => {
      for (let index = 1; index <= 4; index++) {
        const file = 'orders_' + index + '.csv';
        demo.csv.push({ file, ...await importCsv(fixture(file), date) });
      }
    })()]);
    const failure = result.find(task => task.status === 'rejected');
    if (failure) throw failure.reason;
    for (;;) {
      const { queued, failed } = store.stats();
      if (failed) throw new Error('Some inbox events need review.');
      if (!queued) return;
      await sleep(100, undefined, { signal: stop.signal });
    }
  }

  async function dispatch() {
    if (demo.phase === 'running') return;
    await Promise.all(store.claimDispatches(robots).map(async job => {
      let error;
      try {
        const response = await request(baseUrl + '/mock/robots/' + job.robot_id, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: job.payload
        });
        if (!response.ok) throw new Error('Robot returned HTTP ' + response.status);
        const reply = await response.json();
        if (!reply.accepted || reply.dispatch_id !== job.id) throw new Error('Invalid robot acknowledgement.');
      } catch (failure) {
        error = failure;
      }
      if (!stop.signal.aborted) store.dispatchResult(job, error);
    }));
  }

  async function route(req, res, url) {
    const path = url.pathname;
    if (req.method === 'POST' && path === '/api/reset') {
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json'
        || (await readJson(req))?.confirmation !== 'clear') {
        throw new InputError('Type clear to confirm the database reset.');
      }
      if (clearing || demo.phase === 'running') {
        return send(res, 409, { error: 'Wait for the current operation to finish before clearing the database.' });
      }
      clearing = true;
      try {
        await Promise.allSettled(activeWrites);
        store.clear();
        Object.assign(demo, initialDemo());
      } finally {
        clearing = false;
      }
      return send(res, 200, { cleared: true });
    }
    if (clearing && (req.method === 'POST' || path === '/mock/orders')) {
      return send(res, 503, { error: 'Database reset in progress. Try again shortly.' });
    }
    if (req.method === 'GET') {
      if (files.has(path)) {
        const [file, type] = files.get(path);
        return send(res, 200, readFileSync(new URL('../public/' + file, import.meta.url), 'utf8'), type);
      }
      if (path === '/api/orders') {
        const limit = Number(url.searchParams.get('limit') ?? 25);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
          || !Number.isSafeInteger(offset) || offset < 0) throw new InputError('Invalid pagination.');
        return send(res, 200, store.orders(url.searchParams.get('status') ?? '',
          url.searchParams.get('source') ?? '', limit, offset));
      }
      const match = path.match(orderIdRoute);
      if (match) {
        const id = Number(match[1]);
        const order = store.getOrder(id);
        if (!order) return send(res, 404, { error: 'Order not found.' });
        return send(res, 200, match[2] ? store.history(id) : order);
      }
      if (path === '/api/status') return send(res, 200, { ...store.stats(), demo });
      if (path === '/mock/orders') {
        const cursor = url.searchParams.get('time_since') ?? '0';
        const index = Number(cursor);
        if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(index) || index > responses.length) {
          throw new InputError('Invalid fixture checkpoint.');
        }
        const row = responses[index];
        if (!row) return send(res, 200, { response: 200, data: {}, next_checkpoint: cursor, done: true });
        if (row.response !== 200 && store.mockFailure(cursor)) return send(res, row.response, row);
        return send(res, 200, { response: 200, data: row.data ?? {}, next_checkpoint: String(index + 1),
          done: index + 1 === responses.length });
      }
    }
    if (req.method === 'POST') {
      if (path === '/webhooks/orders') {
        const event = webhookEvent(await readJson(req), req.headers['x-delivery-id']);
        return send(res, 202, { queued: Boolean(store.enqueue([event])) });
      }
      if (path === '/api/import/csv') {
        return send(res, 202, await importCsv(await readBody(req), url.searchParams.get('date') ?? today()));
      }
      if (path === '/api/demo') {
        if (demo.phase === 'running') return send(res, 409, { error: 'Demo is already running.' });
        const date = store.checkpoint('demo-date') ?? today();
        store.enqueue([], { stream: 'demo-date', value: date });
        Object.assign(demo, { phase: 'running', error: null, pollError: null, csv: [] });
        demoJob = runDemo(date).then(() => { demo.phase = 'complete'; }, error => {
          demo.phase = 'failed';
          demo.error = error.message;
        });
        return send(res, 202, { started: true });
      }
      const robot = path.match(/^\/mock\/robots\/(robot-[ab])$/)?.[1];
      if (robot) {
        const payload = await readJson(req);
        if (!payload || payload.robot_id !== robot || typeof payload.dispatch_id !== 'string'
          || !payload.dispatch_id || !Array.isArray(payload.items)) throw new InputError('Invalid dispatch payload.');
        const fresh = store.mockAccept(robot, payload.dispatch_id, payload);
        if (fresh && dropFirstRobotReply && robot === 'robot-a'
          && !store.checkpoint('robot-disconnect')) {
          store.enqueue([], { stream: 'robot-disconnect', value: '1' });
          res.destroy();
          return;
        }
        return send(res, 200, { accepted: true, dispatch_id: payload.dispatch_id });
      }
    }
    send(res, 404, { error: 'Route not found.' });
  }

  function loop(delay, work) {
    tasks.push((async () => {
      while (!stop.signal.aborted) {
        try {
          if (!clearing) await trackWrite(async () => work());
        } catch (error) {
          if (!stop.signal.aborted) console.error(error.message);
        }
        await sleep(delay, undefined, { signal: stop.signal });
      }
    })().catch(error => {
      if (!stop.signal.aborted) console.error(error);
    }));
  }

  const server = createServer((req, res) => {
    async function handle() {
      const url = new URL(req.url, 'http://localhost');
      const work = () => route(req, res, url);
      if ((req.method === 'POST' && url.pathname !== '/api/reset') || url.pathname === '/mock/orders') {
        return trackWrite(work);
      }
      return work();
    }
    handle().catch(error => {
      const invalid = error instanceof InputError;
      if (!invalid && !stop.signal.aborted) console.error(error);
      if (!res.headersSent && !res.destroyed) {
        send(res, invalid ? 400 : 503, { error: invalid ? error.message : 'Temporarily unable to complete the request.' });
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const address = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  baseUrl = 'http://' + (address.includes(':') ? '[' + address + ']' : address) + ':' + server.address().port;
  loop(15, () => store.processInbox());
  loop(35, dispatch);
  if (ordersApiUrl) {
    let delay = 0;
    let next = 0;
    loop(pollMs, async () => {
      if (Date.now() < next) return;
      try {
        await poll(ordersApiUrl, ordersApiUrl, ordersApiToken);
        delay = 0;
      } catch (error) {
        delay = Math.min(delay ? delay * 2 : pollMs, 60_000);
        next = Date.now() + delay;
        throw error;
      }
    });
  }

  return { url: baseUrl, store, async close() {
    stop.abort();
    const closed = new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...tasks, demoJob, closed]);
    store.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await start({
    port: Number(process.env.PORT ?? 3000), host: process.env.HOST,
    database: process.env.DB_PATH, ordersApiUrl: process.env.ORDERS_API_URL,
    ordersApiToken: process.env.ORDERS_API_TOKEN, pollMs: Number(process.env.POLL_INTERVAL_MS ?? 5000)
  });
  console.log('Order dashboard: ' + app.url);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
  });
}
