# FACTORY.md

A four-seat software factory in Band Desktop. One human message dispatched all four
Tablekeeper stages; the seats planned, built, reviewed and accepted every stage with no
further human input. This file is enough to stand the factory up again on a different
problem.

## The idea

A seat that writes code and then says the code works has produced two things: a change
and a claim. The claim is the weaker one. So this factory is built on two rules:

1. **No seat accepts its own work.** The seat that writes code never decides it is done.
2. **No decision rests on a claim.** A verdict cites a command the deciding seat ran
   itself, a revision hash, or a line of the requirements.

The event adds a third pressure that shaped the design more than anything: the supplied
checks are only part of what is graded, and a larger hidden suite is written from the
specification. A band that iterates until the visible checks are green will look done
and still fail. The answer is a seat whose whole job is the gap between the
specification and the visible checks.

## Seats

| Seat | Harness / model | Owns | Never does |
|---|---|---|---|
| **coordinator** | Claude Code / claude-sonnet-5 | the plan, every handoff, the final report | writes product code, accepts on its own judgement |
| **auditor** | Claude Code / claude-sonnet-5 | before each build: a numbered list of obligations the visible checks do not exercise, each quoted from the spec. After each build: met/unmet per item with evidence | writes product code, modifies the repository |
| **implementer** | Claude Code / claude-opus-5-5 | building, committing, its own tests, Dockerfile and RUN.md | modifies a supplied check, accepts its own work |
| **reviewer** | Claude Code / claude-opus-5-5 | independent verdict: tamper check, runs the official harness itself in isolated mode, clean-container start, adversarial probes | fixes code |

Model choice is deliberate: the strongest model where code is written and judged, a
cheaper model where the work is reading, routing and listing.

Mandates are in [`mandates/`](mandates/). They name no endpoint, field, error code or
test id from this track — the track arrives in the task the human dispatches. `python -m
harness check` reports zero mandate findings.

## How a stage moves

```
human dispatch (once, all four stages)
        │
   coordinator ── plan ──────────────────────────────────────────┐
        │                                                         │
        ├─▶ auditor:  spec vs visible checks → obligation list    │
        │                                                         │
        ├─▶ implementer: spec + obligation list → commit          │
        │                                                         │
        ├─▶ reviewer: tamper check, harness --mode isolated,      │
        │             clean-container start, adversarial probes   │
        ├─▶ auditor:  every obligation met / unmet, with evidence │
        │                                                         │
        └─ accept only the exact revision both checked ──────────┘
              then: copy stage-N → stage-(N+1), extend the copy
```

Every handoff is self-contained: the coordinator pastes the full stage specification,
the absolute repository path and the commands to run. No seat is ever asked to "read the
room" — a seat sees only messages addressed to it.

## The run that was submitted

One dispatch, then nothing from the human until the coordinator's final report.

| Stage | Built | Accepted | Elapsed | Visible checks | Auditor obligations |
|---|---|---|---|---|---|
| 1 — JSON API | 09:45 | 09:51 | ~16 min | 120/120 | 32/32 met |
| 2 — Browser UI | 10:03 | 10:12 | ~18 min | 120 + 25 | 41/41 met |
| 3 — Policies over time | 10:18 | 10:26 | ~16 min | + 7 | 67/67 met |
| 4 — Replans, series amendments | 10:30 | 10:38 | ~13 min | all four suites | 53/53 met |

Times are PKT on 4 Oct 2026. **Total: 63 minutes**, kickoff 09:35 to final report 10:39.

`python -m harness run --all --mode isolated` on a fresh clone: `stage-1/` through
`stage-4/` each claim their own stage, and none claims the next one.

### Measured cost

From `jam usage rooms` (catalog estimate of model spend; the seats ran on a Claude
subscription, so no per-token bill was incurred):

| Seat | Estimate |
|---|---|
| implementer | $22.91 |
| auditor | $18.34 |
| reviewer | $12.02 |
| coordinator | $6.20 |
| **Total** | **$59.47** (196M tokens, mostly cache reads) |

A rehearsal on the event's practice track cost $11.16 and took 26 minutes.

The auditor costs almost as much as the implementer. That is the price of reading the
specification line by line four times. It bought 193 obligations that the visible checks
never ask about, each one built and then verified.

## How it catches bad work

- **The visible checks are not the target.** At stage 4 the auditor noticed four of the
  six supplied sample checks were regressions of earlier stages — almost nothing of
  stage 4 was visibly tested. It produced 53 obligations instead, and those, not the
  supplied checks, drove the build.
- **Independent oracle.** For the stage-4 seating optimizer the reviewer wrote its own
  brute-force solver straight from the spec text, without reading the implementation,
  and compared it with the service on 150 random scenarios. Zero mismatches.
- **Review changed the work.** Each stage's second commit is the implementer adding
  tests for the auditor's list. A stage-2 review note (a table too small for the party
  was labelled "Taken" instead of "Too small") was carried forward and fixed in stage 3.
- **Same check the judges run.** The reviewer runs the official harness in isolated
  mode — no outbound network, 2 vCPU, 2 GiB — and the auditor separately rebuilt and
  load-tested each container with `--network none`.
- **Tamper check.** The reviewer compares each revision with the one before it; a
  modified, skipped or deleted supplied check is an automatic rejection. None occurred.

## What we tried that failed

Built over the week before kickoff, on practice specifications:

- **An external script as the harness.** The first version ran tests and commits from a
  shell script outside the room, so no agent could fake a result. It worked, but the
  work then happened outside the band's own turns, which the room log cannot show. The
  seats now run the official harness themselves.
- **Re-using a room across runs.** A seat reads everything in its room and picked up a
  stale request from an earlier run. Each run now gets a fresh room.
- **Reading an answer the moment it appears.** A seat wrote "refused", looked again,
  and changed it to "merged"; the first read recorded the wrong outcome. Handoffs now
  name an exact revision, and acceptance is tied to it.
- **Measuring the wrong tree.** With stages in subfolders of one repository, running a
  suite at the worktree root silently measured the parent. A reviewer caught it because
  the test count matched the trunk exactly. Commands now always name the stage folder.

## Limits, honestly

- **No rejection in the submitted run.** Every stage was accepted on its first full
  review; review changed the work by adding tests and carrying one UI fix forward, but
  no candidate was sent back. On a harder problem the loop has not yet been shown to
  converge after a rejection on this track.
- **In-memory state.** The implementer chose Node.js with no dependencies and in-memory
  state. Atomicity comes from a single event loop rather than a database transaction; it
  is correct for one process and would not survive horizontal scaling.
- **Password hashing cost.** The reviewer flagged that seeding several hundred users
  could approach the reset time limit under the 2-vCPU cap. The track's fixtures are
  small, so it was recorded rather than changed.
- **Single author name per commit.** Only the implementer wrote code, so every commit is
  its own; review and audit live in the room log rather than the Git history.

## Stand it up yourself

1. Install Band Desktop, sign in, pass `jam preflight`.
2. Create four headless Claude Code seats named `coordinator`, `auditor`,
   `implementer`, `reviewer`, each with its mandate from `mandates/` as owner
   instructions and the model named on its `Model:` line.
3. Give the seats the permissions an unattended run needs: Git, Docker, Python and a
   browser in the result repository.
4. Create an empty result repository and a fresh room.
5. Send the coordinator one message: the track, the absolute paths of every
   specification, the result repository, the check command, and the rule that each
   stage is copied forward into its own folder.
6. Do not type in the room again until the final report.

Nothing in the mandates refers to this problem. Pointing the factory at a different
specification means changing only the message in step 5.
