# Payment Processing System

A mock payment gateway built with NestJS. Takes a payment in,
asynchronously processes it through a fake third-party gateway,
and tells you what happened. Has all the messy real-world stuff
the assignment asked for: retries, idempotency, webhook callbacks,
race conditions, the works.

---

## What this is built with

- **NestJS** (TypeScript) — framework
- **PostgreSQL** — payments and webhook events
- **Redis** — distributed locks
- **BullMQ** — background job queue (on top of Redis)
- **TypeORM** — database access
- **class-validator** — request body validation
- **Swagger / OpenAPI** — API docs at `/api/docs`

You'll need Node 18+, Postgres, and Redis running locally.

---

## Setup — getting it running

1. Copy the env file and change anything you need:

   ```bash
   cp .env.example .env
   ```

   Defaults work for a fresh local Postgres / Redis. If yours need
   different credentials, edit `.env`.

2. Make sure Postgres and Redis are running. Easiest way:

   ```bash
   docker run -d --name pg    -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
   docker run -d --name redis  -p 6379:6379 redis:7
   ```

   Then create the database:

   ```bash
   PGPASSWORD=postgres createdb -h localhost -U postgres payment_system
   ```

3. Install and run:

   ```bash
   yarn install
   yarn start:dev
   ```

4. Open `http://localhost:3000/api/docs` for Swagger.

That's it. Tables get auto-created the first time the app starts up
(via `synchronize: true` — fine for the assignment; production would
use real migrations).

### If you see schema errors on startup

Something like *"column gatewayTransactionId does not exist"* or
*"column version contains null values"* means you have leftover
tables from an older code version. Easiest fix:

```bash
psql -h localhost -U postgres -d payment_system -c \
  "DROP TABLE IF EXISTS payments, webhook_events CASCADE;
   DROP TYPE IF EXISTS payments_status_enum, webhook_events_processingstatus_enum CASCADE;"
```

Then restart. Tables get recreated fresh.

---

## Trying it out

The fast way (since computing webhook signatures by hand is tedious):

1. **Create a payment** — `POST /payments` with header
   `Idempotency-Key: <any unique string>` and body:

   ```json
   { "amount": 19999, "currency": "INR" }
   ```

   You get back a `PAY_xxx` id. Amount is in minor units (paise / cents).

2. **Watch it process** — `GET /payments/{id}` a few seconds later.
   You'll see it move from INITIATED → PROCESSING → SUCCESS (or
   FAILED / BLOCKED, depending on the random outcome of the fake gateway).

3. **See the full audit trail** — `GET /webhooks?paymentId=PAY_xxx`
   shows every state change as a webhook event, newest first.

4. **Send an external webhook** (e.g. simulating a real gateway
   sending a status update) — use `POST /dev/send-webhook`. The
   server signs the body for you so you don't have to compute HMACs.

5. **Get a specific event** — `GET /webhooks/{eventId}`.

---

## Endpoints

| Method | Path                          | What it does                              |
|--------|-------------------------------|-------------------------------------------|
| POST   | `/payments`                   | Create a payment (needs `Idempotency-Key`)|
| GET    | `/payments/{id}`              | Get a payment's current status            |
| POST   | `/webhooks/payment`           | Receive a gateway / lifecycle webhook (needs HMAC) |
| GET    | `/webhooks`                   | List webhook events, newest first         |
| GET    | `/webhooks/{eventId}`         | Get one webhook event by id               |
| POST   | `/dev/sign-webhook`           | DEV — compute HMAC for any body           |
| POST   | `/dev/send-webhook`           | DEV — sign + send to /webhooks/payment in one shot |

The `/dev/*` endpoints are only mounted when `NODE_ENV !== 'production'`.

---

## How the pieces fit together

```
[client]
   |
   |  POST /payments        (with Idempotency-Key)
   v
[PaymentsService]                                 +-----------------+
   - INSERT row, status=INITIATED                  | webhook_events  |
   - emit INITIATED self-webhook ---------------+  |   audit table   |
   - put job on BullMQ queue                    |  +-----------------+
                                                |          ^
                                                |          |
                                                v          |
                                           [/webhooks/payment]
                                                |          |
                                                | verify   | record
                                                | sig      | + update
                                                | apply    |
                                                v          |
                                           [Payment row]<--+
                                                 ^
                                                 |
[BullMQ worker]                                  |
   - picks job                                   |
   - grabs Redis lock                            |
   - emits PROCESSING self-webhook --------------+
   - calls fake gateway                          |
   - emits SUCCESS/FAILED/BLOCKED self-webhook --+
```

Important point — **the processor never writes to the payment table
directly**. Every state change goes through the webhook handler. So:

- Real external webhooks and internal lifecycle events use the **same
  code path** (verify signature → dedup → row lock → state machine).
- `webhook_events` gets a row for every transition automatically, no
  separate "log this state change" code.
- The audit trail is complete by design, not by remembering to call
  some logging function.

---

## What's implemented (vs. the assignment)

### Payment Lifecycle

States: `INITIATED → PROCESSING → SUCCESS / FAILED / BLOCKED`.
Plus same-state transitions are allowed (idempotent re-applies),
and INITIATED can jump straight to terminal because of the "early
webhook" case the assignment mentions.

### Failure handling & retry logic

- BullMQ does the retries with exponential backoff
- Tunable via env vars (`PAYMENT_MAX_ATTEMPTS`, `PAYMENT_BACKOFF_INITIAL_MS`)
- We split errors into two buckets:
  - **Transient** (timeout, 502, network blip) → BullMQ retries
  - **Non-retriable** (declined, fraud block) → mark terminal,
    don't waste retry attempts on something that won't change
- On the very last attempt, even transient errors get marked FAILED,
  so a payment never gets stuck in PROCESSING

### Idempotency

- `POST /payments` requires an `Idempotency-Key` header
- DB has a unique index on the column
- Two requests with the same key arriving at the same millisecond
  are both handled correctly — one wins, the other returns the
  winner. No 500.

### Concurrency control

Three layers stop the worker and webhook handlers from racing each
other on the same payment row:

1. **Redis lock** keyed by `lock:payment:<id>` — outer guard
2. **Postgres `SELECT FOR UPDATE`** inside the webhook handler — locks
   the actual row so even if two webhooks arrive at once, one waits
3. **`@VersionColumn`** on the Payment entity — belt-and-braces
   optimistic check if anything sneaks past the row lock

We deliberately **don't** hold the row lock during the multi-second
gateway call. The flow is: lock → flip to PROCESSING → unlock → call
gateway → lock → write final result → unlock.

### Fake external gateway

`FakeGatewayService` simulates the real thing:

- Random latency (200ms–1.8s)
- Real timeouts via AbortController (not just "throw after a delay")
- Weighted outcomes:
  - ~55% success
  - ~15% declined (treated as non-retriable)
  - ~5% fraud-blocked (non-retriable)
  - ~15% transient 502
  - ~10% read timeout

Wrapped in a tiny **circuit breaker** — if 5 calls in a row fail it
opens for 20s, then sends one probe to see if upstream is back.

### Webhook / callback handling

`/webhooks/payment` accepts both real gateway callbacks AND the
processor's self-webhooks. Same code path for both.

- **HMAC-SHA256 signature** required (`X-Webhook-Signature` header)
- **Atomic dedup** via the unique index on `eventId` — no TOCTOU race
- **Early callbacks** (webhook arrives before the worker even started)
  are applied directly via INITIATED → terminal
- **Duplicate webhooks** return `{duplicate: true}`, don't reprocess
- **Conflicting webhooks** (says FAILED but payment is already SUCCESS)
  get rejected with a logged note, original state preserved
- **Bad signatures** are recorded in `webhook_events` for an audit
  trail and return 401
- **Unknown payments** are recorded as REJECTED, don't crash

### Data consistency

Every payment update happens inside a TypeORM transaction with a
pessimistic write lock on the row. The webhook event insert and the
payment update are in the same transaction, so they either both
happen or neither does.

### Logging & observability

Winston with three transports — colored console, an error-only file
log, and a combined file log (both rotate to `logs/`). Every payment
lifecycle event is logged with the payment id so you can grep one
payment's full journey.

### Tests

Real ones — not the auto-generated `expect(x).toBeDefined()`
boilerplate.

```bash
yarn test
```

Covers:

- State machine transitions (allowed and disallowed)
- PaymentsService — idempotency replay, unique-violation race
- WebhooksService — signature verification (good, bad, missing),
  early webhook, duplicate, conflict, no-op, unknown payment
- CircuitBreaker — closed → open → half-open → closed lifecycle

### Bonus stuff from the assignment

- **Queue-based retry** — BullMQ with exponential backoff (in code)
- **Circuit breaker** — in `circuit-breaker.service.ts`
- **Rate limiting** — `@nestjs/throttler`, 60 req/min per IP
- **API documentation** — Swagger at `/api/docs`

---

## Project layout

```
src/
├── app.module.ts
├── main.ts                  Bootstrap, swagger, rawBody capture
├── common/
│   ├── exceptions/          TransientGatewayError, NonRetriableGatewayError
│   ├── logger/              Winston config
│   └── redis/               Token-based distributed lock
├── config/                  env-driven tunables
└── modules/
    ├── dev/                 DEV-only signing helpers
    ├── payments/
    │   ├── controllers/     /payments endpoints
    │   ├── dto/             request validation
    │   ├── entities/        Payment + WebhookEvent
    │   ├── enums/           PaymentStatus
    │   ├── processors/      BullMQ worker
    │   ├── services/        PaymentsService, FakeGatewayService, CircuitBreaker
    │   └── utils/           State machine
    └── webhooks/
        ├── webhooks.controller.ts        POST + GETs
        ├── webhooks.service.ts           verify, handle, list, get
        └── internal-webhook-emitter.service.ts   self-signs + self-POSTs
```

---

## Things I'd do differently in production

- **Migrations instead of `synchronize: true`** — auto-sync is fine
  for a take-home but writes can drop data
- **Multi-instance circuit breaker** — current one is per-process;
  in a real fleet you'd want the state in Redis
- **Tracing / correlation IDs** — right now logs are tied to payment
  id, which is enough; for prod you'd want request IDs threaded
  through everything via AsyncLocalStorage
- **Outbox for self-webhooks** — currently if the self-POST fails
  mid-process (very unlikely since it's localhost), the lifecycle
  event isn't recorded. A proper outbox table with a sweeper would
  guarantee delivery
- **Separate rejected-webhooks table** — bad signatures share the
  `eventId` namespace with real ones. Theoretically an attacker
  spamming forged eventIds could block a legit webhook later if
  the IDs collide. Mostly theoretical (gateway eventIds have lots
  of entropy) but worth fixing for real
- **Real e2e tests** with testcontainers spinning up Postgres + Redis

---

## A few notes on assumptions

- **Amounts are in minor units** — `19999` means ₹199.99, not ₹19,999.
  Storing money as integers is the right call (no float precision bugs).
- **`/dev/*` endpoints are dev-only** — they auto-disable when
  `NODE_ENV=production`. Don't deploy them.
- **The fake gateway doesn't HTTP-callback anything** — it's just
  a function in-process. Our processor packages up the result and
  POSTs it to `/webhooks/payment` itself, simulating what a real
  gateway would do over the network.
"# payment-processing-system" 
