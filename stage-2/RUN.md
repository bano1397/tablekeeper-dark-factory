# Tablekeeper — Stage 2

A restaurant reservations HTTP API with a browser UI (search, booking, lookup,
signup/login) and combined-table bookings. Node.js 22, standard library only (no
npm dependencies), state held in memory. The UI is plain HTML/CSS/JS served from
`src/public/` with system fonts, so the browser needs nothing from the internet.

## Build and start

From this folder:

```sh
docker build -t tablekeeper-stage2 . && docker run --rm -e PORT=8080 -p 8080:8080 tablekeeper-stage2
```

The service listens on `0.0.0.0:$PORT` (default `8080`). Open http://localhost:8080/
for the UI (`/`, `/signup`, `/login`, `/lookup`). Check the API with:

```sh
curl http://localhost:8080/health    # {"status":"ok"}
```

State is in memory: seed it with `POST /_test/reset` and it is lost when the
container stops.

## Without Docker

```sh
PORT=8080 node src/server.js
```

## Tests

```sh
npm test        # node --test test/*.test.js — API tests, server started in-process
```

Browser tests (Python with `pytest`, `httpx`, `playwright` + chromium) run against
live services; the upgrade test also needs the stage-1 service:

```sh
PORT=18082 node src/server.js &
PORT=18081 node ../stage-1/src/server.js &
TK_BASE=http://127.0.0.1:18082 TK_PREV=http://127.0.0.1:18081 python -m pytest test/ui
```

## No-network load probe

Runs the image the way the grader does (no network, 2 vCPU, 2 GiB) and drives 50
in-flight requests from inside the container:

```sh
docker build -t tablekeeper-stage2 .
CID=$(docker run -d --rm --network none --cpus 2 --memory 2g -e PORT=8080 tablekeeper-stage2)
docker exec -i $CID node - < scripts/load.js    # prints LOAD OK
docker stop $CID
```

## Layout

| Path | Contents |
|---|---|
| `src/server.js` | HTTP server, body collection, error envelope |
| `src/ui.js` | HTML shell for the screen routes, static assets |
| `src/public/` | Browser client (`app.js`), styles (`app.css`), icon |
| `src/app.js` | Routes and request handlers |
| `src/store.js` | In-memory state, reset-fixture loading, export/import |
| `src/tz.js` | IANA time-zone arithmetic (DST gaps and overlaps) via ICU |
| `src/validate.js` | Shared input parsers |
| `src/passwords.js` | scrypt password hashing |

## Design notes

- **No double booking.** Every check-then-write runs synchronously on Node's single
  event loop, so concurrent requests cannot interleave between the overlap check and
  the write. Occupancy is `[starts_at, starts_at + duration)` in absolute time.
- **Idempotency** records are kept per user, method, path and key, only for successful
  writes. A replay returns the stored original response with status 200.
- **Local times** resolve to the first occurrence on a fall-back night; a time in the
  spring-forward gap is `invalid_local_time` and never appears in availability.
- **Passwords** are stored as scrypt hashes (fixture users at a lower cost so large
  resets stay fast). Tokens are random and never expire.
- **Combined tables**: a reservation holds a set of one table or one declared pair;
  it overlaps another booking when they share any table.
- **Browser recovery**: searches are numbered and late responses dropped; the booking
  form keeps one idempotency key per request body, so an unchanged resubmit or a retry
  after a lost response replays the original booking instead of creating another.
- **Upgrades**: import accepts stage-1 exports (single `table_id` reservations).
