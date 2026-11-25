# Order dispatch homework

Requires **Node.js 24 or newer**. From the repository root:

```sh
node src/server.js
```

Open **http://127.0.0.1:3000** and click **Run demo**. The server initializes SQLite on first launch. The demo sends the webhook fixture over local HTTP, polls the fixture-backed API, and imports all four CSVs. Filter by source or status and select an order number to see its items and event history. Due orders are assigned to two simulated robots once fixture ingestion completes. Scheduled orders stay queued until their meal time.

Use **Clear database** and type `clear` to reset saved orders, history, checkpoints, and mock robot jobs. You can then run the demo from the beginning. A configured external poller resumes after the reset and can import data again.

The demo uses the supplied fixtures in `fixtures/`. On a fresh database it produces 999 webhook orders, 60 polling orders, and 267 CSV orders. Re-running it on the same database is safe. To run against a fresh database, use a different file:

```sh
DB_PATH=data/fresh.sqlite node src/server.js
```

Run the integration tests with `node --test`. They listen on ephemeral loopback ports.

## Try individual inputs

- **Webhook.** Send JSON with `order_id`, `order_source`, and `items` to `POST /webhooks/orders`. Optional fields include `scheduled_at` (ISO 8601 with a timezone) and `update: ["cancelled"]`. The demo replays fixture requests in bursts and preserves order within each external order. An optional `X-Delivery-Id` header supplies the event identity.
- **Polling.** The demo calls `GET /mock/orders?time_since=0` through the same HTTP client used for configured providers. The fixture mock returns a line-index checkpoint and emits the recorded errors once per position. Retrying the same position returns the recovered data, including any items recorded in the partial response.
- **CSV.** Use **Import CSV** or post the raw file to `POST /api/import/csv?date=YYYY-MM-DD`. Use the same export date for successive snapshots of the same survey. The response reports queued rows, duplicates, and invalid records. The demo remembers the export date it used on its first run.

For example:

```sh
curl -i http://127.0.0.1:3000/webhooks/orders \
  -H 'Content-Type: application/json' \
  -H 'X-Delivery-Id: sample-001' \
  -d '{"order_id":"sample-1","order_source":"manual","items":["Sandwich"]}'
```

## Architecture

Node runs the HTTP server, static frontend, ingestion and dispatch loops, and local HTTP mocks in one process. SQLite stores the durable state. Node's built-in HTTP and SQLite modules keep startup to one command. The frontend uses browser APIs and serves from the same origin. SQLite writes are synchronous, so CSV inserts and inbox processing use bounded batches and yield between them.

| Pipeline | Identity and processing |
|---|---|
| Webhook | An order is scoped by provider and external order ID. Delivery IDs deduplicate retries when available. Otherwise a fingerprint of the normalized payload identifies repeats. The handler commits to the SQLite inbox before returning HTTP 202. Orders with empty item lists remain visible for review and cannot be dispatched. |
| Polling | The item keys identify lines. The numeric `order` field groups those lines into orders. Each response merges line deltas into the previous state. The HTTP client saves a successful batch and its checkpoint in one transaction. Any error, including a partial HTTP 500, leaves the checkpoint in place. |
| CSV | The survey has no order ID, so identity uses normalized row data, the calculated meal time, and an occurrence number for identical rows within an export. Successive fixture uploads add 75, 39, 75, and 78 orders. Without a source ID, a changed row appears as a second order. The demo schedules breakfast at 08:00, lunch at 12:00, and dinner at 18:00 UTC on the export date or the following day. |

The inbox worker processes events in order for each order. It applies the change, appends a history record, and marks the event processed in one transaction. Failed events retry with backoff. After five failures, they remain stored for inspection, and later events for that order wait behind the failed event. The dashboard reports the failed count. Order reads are available at `GET /api/orders` (optional `source`, `status`, `limit`, and `offset`), `GET /api/orders/:id`, and `GET /api/orders/:id/events`.

The dispatcher claims due orders in SQLite. It saves the robot assignment and a stable dispatch ID before sending the payload. Each simulated robot accepts one pending assignment at a time. The mock records acceptance durably by robot and dispatch ID. Robot A drops its first acknowledgment to demonstrate that retrying the same assignment does not create a second job. The app marks the order `dispatched` only after acknowledgment. After five failed attempts it records `dispatch_review` and reserves that robot until reconciliation. A cancellation before assignment stops dispatch. A cancellation after assignment is recorded in the history for reconciliation, since the mock has no cancel API.

The robot payload contains `dispatch_id`, `robot_id`, `order_id`, `items` (each with a name and quantity), and `notes`. Polling line items already marked with the courier, delivered, or cancelled are excluded from dispatch. The demo holds dispatch while replaying so recorded updates and cancellations can be applied before assigning remaining due orders.

## Configuration and scope

| Variable | Default |
|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `3000` |
| `DB_PATH` | `data/orders.sqlite` |
| `ORDERS_API_URL` | Unset. Set to start automatic polling against a configured provider. |
| `ORDERS_API_TOKEN` | Unset. Optional bearer token. |
| `POLL_INTERVAL_MS` | `5000` |

The polling adapter expects a successful JSON response with `response: 200`, a `data` object keyed by item ID, and a string `next_checkpoint`. It sends the last committed checkpoint as `time_since` and starts a configured provider from the Unix epoch. A real provider with a different format needs an adapter. The local mock and demo controls are designed for a single trusted reviewer on loopback. The webhook mock has no provider signature scheme, and the app has no network authorization layer.

[AI session log](AI_SESSION.md)
