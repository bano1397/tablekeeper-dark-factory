# Tablekeeper — Stage 3

A restaurant reservations HTTP API with a browser UI (search, booking, lookup,
signup/login), combined-table bookings, dated booking policies, availability
explanations, reservation history and recurring reservation series. Node.js 22, standard library only (no
npm dependencies), state held in memory. The UI is plain HTML/CSS/JS served from
`src/public/` with system fonts, so the browser needs nothing from the internet.

## Build and start

From this folder:

```sh
docker build -t tablekeeper-stage3 . && docker run --rm -e PORT=8080 -p 8080:8080 tablekeeper-stage3
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
PORT=18083 node src/server.js &
PORT=18082 node ../stage-2/src/server.js &
TK_BASE=http://127.0.0.1:18083 TK_PREV=http://127.0.0.1:18082 python -m pytest test/ui
```

## No-network load probe

Runs the image the way the grader does (no network, 2 vCPU, 2 GiB) and drives 50
in-flight requests from inside the container:

```sh
docker build -t tablekeeper-stage3 .
CID=$(docker run -d --rm --network none --cpus 2 --memory 2g -e PORT=8080 tablekeeper-stage3)
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
| `src/store.js` | In-memory state, reset-fixture loading, export/import (accepts stage-1/2 exports) |
| `src/policy.js` | Policy 0, dated policy selection, accepted-terms snapshots, policy validation |
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
- **Upgrades**: import accepts stage-1 and stage-2 exports; their bookings become
  revision 1 under policy 0 with a single `created` history entry.
- **Policies**: a booking takes the policy whose `effective_from` is the latest not after
  its local start date (ties: highest version) and stores it as `accepted_terms`. Cancel
  and amendment cutoffs use the accepted terms; a real amendment re-validates everything
  under the resulting date's policy. Publishing never edits existing bookings.
- **Revisions and history**: every real change, cancel and creation is one revision and
  one history entry; no-ops and replays record nothing. `expected_revision` on PATCH and
  moves rejects stale writes with `stale_revision`.
- **Series**: adoption plans every occurrence first (each under its own date's policy)
  and only then writes, so a failing occurrence leaves nothing behind.
- **Restaurant revision** is tracked internally (bookings, real amendments, cancels,
  publications, adoptions, move batches) but not exposed in stage 3.
