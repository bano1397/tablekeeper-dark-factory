# Tablekeeper — built by a four-seat dark factory

**Team:** signal-loom (Shehar Bano, solo) · **Track:** tablekeeper · **Event:** WeAreDevelopers × BAND — AI Dark Factory

A restaurant reservation service, like OpenTable, built in four stages by four coding
agents in one Band Desktop room. One human message started the run; the seats planned,
built, reviewed and accepted all four stages on their own in 63 minutes.

## How to read this repository

| Path | What it is |
|---|---|
| [`FACTORY.md`](FACTORY.md) | The factory: seats, design choices, measured time and cost, how it catches bad work, what failed |
| [`mandates/`](mandates/) | One standing instruction per seat — generic, nothing track-specific |
| `room.json` | The full Band room log of the submitted run, downloaded unchanged |
| [`stage-1/`](stage-1/) | JSON API: restaurants, availability, idempotent bookings, atomic multi-booking moves, export/import |
| [`stage-2/`](stage-2/) | Browser product: search and availability grid, booking, confirmation, lookup, recovery from stale and lost responses, combined tables |
| [`stage-3/`](stage-3/) | Effective-dated policies, truthful history, recurring series |
| [`stage-4/`](stage-4/) | Series amendments and closure replanning with preview and atomic apply |

Each stage folder is a complete service with its own `Dockerfile` and `RUN.md`, and
carries every earlier stage forward.

## Run it

```sh
cd stage-4
docker build -t tablekeeper . && docker run --rm -p 8080:8080 tablekeeper
# open http://localhost:8080
```

## Result

`python -m harness run --track tablekeeper --repo . --all --mode isolated`:

```
stage-1/: claims stage 1
stage-2/: claims stage 2
stage-3/: claims stage 3
stage-4/: claims stage 4
```

Code under `stage-N/` was written by the band. `README.md` and `FACTORY.md` were written
by the human afterwards.

## Licence

MIT
