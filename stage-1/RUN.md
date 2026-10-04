# Tablekeeper — Stage 1

A restaurant reservations HTTP API. Node.js 22, standard library only (no npm
dependencies), state held in memory. All runtime assets are in the image; the
service makes no outbound network calls.

## Build and start

From this folder:

```sh
docker build -t tablekeeper-stage1 . && docker run --rm -e PORT=8080 -p 8080:8080 tablekeeper-stage1
```

The service listens on `0.0.0.0:$PORT` (default `8080`). Check it with:

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
npm test        # node --test test/*.test.js — starts the server in-process on a free port
```

## Layout

| Path | Contents |
|---|---|
| `src/server.js` | HTTP server, body collection, error envelope |
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
- **Passwords** are stored as scrypt hashes. Tokens are random and never expire.
