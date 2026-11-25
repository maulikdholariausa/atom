import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const terminal = new Set(['cancelled', 'canceled', 'delivered', 'with_courier']);
const iso = () => new Date().toISOString();

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS inbox (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, event_key TEXT NOT NULL, order_key TEXT NOT NULL,
      payload TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT,
      UNIQUE (source, event_key)
    );
    CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(id) WHERE processed_at IS NULL;
    CREATE INDEX IF NOT EXISTS inbox_pending_order ON inbox(source,order_key,id) WHERE processed_at IS NULL;
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, order_key TEXT NOT NULL,
      status TEXT NOT NULL, details TEXT NOT NULL, fulfil_at TEXT, updated_at TEXT NOT NULL,
      UNIQUE (source, order_key)
    );
    CREATE INDEX IF NOT EXISTS orders_ready ON orders(status, fulfil_at, id);
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
      kind TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS history_order ON history(order_id, id);
    CREATE TABLE IF NOT EXISTS checkpoints (stream TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mock_failures (checkpoint TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS dispatches (
      id TEXT PRIMARY KEY, order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
      robot_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mock_robot_jobs (
      robot_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (robot_id, dispatch_id)
    );
  `);

  const query = sql => db.prepare(sql);
  const insertInbox = query(`INSERT INTO inbox(source,event_key,order_key,payload,received_at)
    VALUES(?,?,?,?,?) ON CONFLICT(source,event_key) DO NOTHING`);
  const readyInbox = query(`SELECT * FROM inbox i
    WHERE processed_at IS NULL AND attempts < 5 AND retry_at <= ?
    AND NOT EXISTS (SELECT 1 FROM inbox prev WHERE prev.id < i.id
      AND prev.processed_at IS NULL AND prev.source = i.source
      AND prev.order_key = i.order_key)
    ORDER BY id LIMIT 20`);
  const findOrder = query('SELECT * FROM orders WHERE source=? AND order_key=?');
  const insertOrder = query(`INSERT INTO orders(source,order_key,status,details,fulfil_at,updated_at)
    VALUES(?,?,?,?,?,?) RETURNING id`);
  const updateOrder = query('UPDATE orders SET status=?,details=?,fulfil_at=?,updated_at=? WHERE id=?');
  const orderById = query('SELECT * FROM orders WHERE id=?');
  const insertHistory = query('INSERT INTO history(order_id,kind,at,detail) VALUES(?,?,?,?)');
  const getCheckpoint = query('SELECT value FROM checkpoints WHERE stream=?');
  const saveCheckpoint = query(`INSERT INTO checkpoints VALUES(?,?)
    ON CONFLICT(stream) DO UPDATE SET value=excluded.value`);
  const setProcessed = query('UPDATE inbox SET processed_at=?,error=NULL WHERE id=?');
  const setInboxError = query('UPDATE inbox SET attempts=attempts+1,retry_at=?,error=? WHERE id=?');
  const activeRobot = query(`SELECT 1 FROM dispatches WHERE robot_id=? AND status!='accepted' LIMIT 1`);
  const readyOrder = query(`SELECT * FROM orders o WHERE status IN ('ready','scheduled')
    AND (fulfil_at IS NULL OR fulfil_at <= ?) AND NOT EXISTS (SELECT 1 FROM inbox i
      WHERE i.source=o.source AND i.order_key=o.order_key AND i.processed_at IS NULL)
    ORDER BY fulfil_at,id LIMIT 1`);
  const setStatus = query('UPDATE orders SET status=?,updated_at=? WHERE id=?');

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function log(id, kind, detail) {
    insertHistory.run(id, kind, iso(), JSON.stringify(detail));
  }

  function enqueue(events, checkpoint) {
    return transaction(() => {
      let added = 0;
      for (const event of events) {
        added += Number(insertInbox.run(event.source, event.eventKey, event.orderKey, JSON.stringify(event), iso()).changes);
      }
      if (checkpoint) saveCheckpoint.run(checkpoint.stream, checkpoint.value);
      return added;
    });
  }

  function apply(event) {
    const previous = findOrder.get(event.source, event.orderKey);
    const old = previous && JSON.parse(previous.details);
    const details = { ...old, ...event.order };
    let cancelled = event.cancelled || previous?.status === 'cancelled';
    let externallyFulfilled = false;
    if (event.source === 'polling') {
      const items = new Map(old?.items.map(item => [item.id, item]));
      for (const item of event.order.items) {
        const existing = items.get(item.id);
        items.set(item.id, { ...existing, ...Object.fromEntries(
          Object.entries(item).filter(([, value]) => value !== undefined)) });
      }
      details.items = [...items.values()];
      const dates = details.items.map(item => item.scheduledAt).filter(Boolean).sort();
      details.fulfilAt = dates.at(-1) ?? null;
      const statuses = details.items.map(item => item.status.toLowerCase());
      cancelled ||= statuses.every(status => ['cancelled', 'canceled'].includes(status));
      externallyFulfilled = statuses.every(status => terminal.has(status));
    }

    let status = details.fulfilAt && details.fulfilAt > iso() ? 'scheduled' : 'ready';
    if (cancelled) status = 'cancelled';
    else if (externallyFulfilled) status = 'external_fulfilled';
    else if (!details.items.length) status = 'order_review';
    const committed = ['dispatch_pending', 'dispatch_review', 'dispatched'].includes(previous?.status);
    if (committed) status = previous.status;
    const serialized = JSON.stringify(details);
    const previousDetails = old && JSON.stringify(old);
    const cancellationRequested = cancelled && committed
      && (event.source === 'webhook' || previousDetails !== serialized);
    if (previous && previousDetails === serialized && previous.status === status && !cancellationRequested) return;
    const values = [status, serialized, details.fulfilAt ?? null, iso()];
    const id = previous?.id ?? insertOrder.get(event.source, event.orderKey, ...values).id;
    if (previous) updateOrder.run(...values, id);
    const kind = cancellationRequested ? 'cancellation_requested'
      : status === 'cancelled' ? 'cancelled' : previous ? 'updated' : 'created';
    log(id, kind, { status, source: event.source, details });
  }

  function processInbox() {
    for (const row of readyInbox.all(Date.now())) {
      try {
        transaction(() => {
          apply(JSON.parse(row.payload));
          setProcessed.run(iso(), row.id);
        });
      } catch (error) {
        setInboxError.run(Date.now() + 250 * 2 ** row.attempts, error.message, row.id);
      }
    }
  }

  function claimDispatches(robotIds) {
    return transaction(() => {
      for (const robot of robotIds) {
        if (activeRobot.get(robot)) continue;
        const order = readyOrder.get(iso());
        if (!order) break;
        const id = randomUUID();
        const details = JSON.parse(order.details);
        const payload = { dispatch_id: id, robot_id: robot, order_id: order.id,
          items: details.items.filter(item => !terminal.has(item.status?.toLowerCase()))
            .map(({ name }) => ({ name, quantity: 1 })), notes: details.notes ?? '' };
        query(`INSERT INTO dispatches(id,order_id,robot_id,payload,status) VALUES(?,?,?,?,'pending')`)
          .run(id, order.id, robot, JSON.stringify(payload));
        setStatus.run('dispatch_pending', iso(), order.id);
        log(order.id, 'dispatch_assigned', { robot, dispatchId: id });
      }
      return query(`SELECT * FROM dispatches WHERE status='pending' AND retry_at<=?`).all(Date.now());
    });
  }

  function dispatchResult(job, error) {
    transaction(() => {
      if (error) {
        const review = job.attempts + 1 >= 5;
        query('UPDATE dispatches SET attempts=attempts+1,status=?,retry_at=? WHERE id=?')
          .run(review ? 'review' : 'pending', Date.now() + 250 * 2 ** job.attempts, job.id);
        if (review) setStatus.run('dispatch_review', iso(), job.order_id);
        log(job.order_id, review ? 'dispatch_needs_review' : 'dispatch_retry', {
          robot: job.robot_id, dispatchId: job.id, error: error.message });
      } else {
        query("UPDATE dispatches SET status='accepted',attempts=attempts+1 WHERE id=?").run(job.id);
        setStatus.run('dispatched', iso(), job.order_id);
        log(job.order_id, 'dispatched', { robot: job.robot_id, dispatchId: job.id });
      }
    });
  }

  const decode = row => row && { ...row, details: JSON.parse(row.details) };
  return {
    close: () => db.close(),
    enqueue, processInbox, claimDispatches, dispatchResult,
    clear() {
      transaction(() => db.exec(`
        DELETE FROM dispatches;
        DELETE FROM history;
        DELETE FROM orders;
        DELETE FROM inbox;
        DELETE FROM checkpoints;
        DELETE FROM mock_failures;
        DELETE FROM mock_robot_jobs;
      `));
    },
    checkpoint: stream => getCheckpoint.get(stream)?.value,
    mockFailure: checkpoint => Boolean(query(`INSERT INTO mock_failures VALUES(?)
      ON CONFLICT DO NOTHING`).run(checkpoint).changes),
    mockAccept(robot, id, payload) {
      return Boolean(query(`INSERT INTO mock_robot_jobs VALUES(?,?,?)
        ON CONFLICT DO NOTHING`).run(robot, id, JSON.stringify(payload)).changes);
    },
    mockJobCount: () => query('SELECT count(*) AS count FROM mock_robot_jobs').get().count,
    getOrder: id => decode(orderById.get(id)),
    history: id => query('SELECT * FROM history WHERE order_id=? ORDER BY id').all(id)
      .map(row => ({ ...row, detail: JSON.parse(row.detail) })),
    orders(status, source, limit, offset) {
      const where = " WHERE (?='' OR status=?) AND (?='' OR source=?)";
      const args = [status, status, source, source];
      return {
        count: query('SELECT count(*) AS count FROM orders' + where).get(...args).count,
        orders: query('SELECT * FROM orders' + where + ' ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?')
          .all(...args, limit, offset).map(decode)
      };
    },
    stats() {
      return {
        queued: query('SELECT count(*) AS count FROM inbox WHERE processed_at IS NULL AND attempts<5').get().count,
        failed: query('SELECT count(*) AS count FROM inbox WHERE processed_at IS NULL AND attempts>=5').get().count,
        orders: query('SELECT source,status,count(*) AS count FROM orders GROUP BY source,status').all()
      };
    }
  };
}
