# Phase 2.2 — Stop button, force-unwedge, and the pre-QA cost checkpoint

Depends on Phase 2.1 — the cost checkpoint reuses that phase's gate machinery
(`onReview`-style pause + SSE event + resume endpoint). Do not reinvent it.

## Goal A — Stop

A running job can be aborted from the UI.

### Files / anchors

- `pipeline.ts:407-428` — the `query({ … })` call. The Agent SDK accepts an
  `AbortController`'s signal in its options; thread one through.
- `runClone` (`pipeline.ts:459`) takes the signal (extend the options argument added in
  Phase 2.1 rather than adding a third positional parameter). Check it at each step
  boundary — after `mapPages` (`:472`), after `crawlPages` (`:473`), after `captureMobile`
  (`:474`) — so a stop during the cheap phases takes effect promptly instead of waiting for
  the rebuild.
- Forward the signal to the `serve.ts` spawns (`serve.ts:47`, `serve.ts:72`) so a stop
  during the export/publish step kills the child rather than orphaning it. `spawn` accepts
  `signal` in its options; combine with the pid/pgid handling from Phase 1.4.
- `server.ts`: `Job` (`server.ts:14-20`) holds the `AbortController`. New route
  `POST /api/clone/:id/stop` next to the others (`server.ts:196-252`): 404 on unknown id,
  409 if the job is already done, 200 otherwise. Aborting must land the job in a terminal
  state — `done: true` with a `Stopped` error or a dedicated `stopped` event; whichever you
  choose, the SSE replay at `server.ts:235-246` must reproduce it for a late subscriber.
- UI (`server.ts:129-182`): a Stop button, enabled while a job is in flight, disabled with
  the Clone button restored afterwards.

## Goal B — `force` on the 409

- `server.ts:211-215` returns 409 when `job && !job.done`. Today a wedged job means
  restarting the server.
- Accept `{ url, force: true }` on `POST /api/clone`: abort the existing job, then start the
  new one. Without `force`, the 409 stays exactly as it is — and its JSON body should hint
  that `force` exists.
- The UI's 409 branch (`server.ts:151-155`) should offer the retry rather than just printing
  "A clone job is already running."

## Goal C — Cost checkpoint before QA

- PLAN_V1: *"Build done, QA will cost ~$X — proceed?"*
- The rebuild's cost is known from the `result` / streamed cost handling
  (`pipeline.ts:443-451`, plus whatever Phase 1.2 added). QA is the last stretch of the
  same agent session (`pipeline.ts:380-384`, marker at `pipeline.ts:235`), so the checkpoint
  is naturally a **pre-rebuild** or **post-build** pause, not a mid-`query()` one — pick the
  seam you can actually implement without splitting the session, and state which in the
  commit message. A pause before `rebuild` (`pipeline.ts:481`) that quotes the estimate
  based on page count is acceptable and simple; a mid-session pause is not worth a
  refactor.
- Reuse the Phase 2.1 event + resume plumbing with a distinct event name (e.g. `confirm`).
  Do not fork a second, parallel gate implementation.
- Same replay requirement: a pending checkpoint must be re-emitted on reconnect.

## Acceptance criteria

- Stop during any step ends the job within a few seconds; no orphaned `next build`, `npx
  serve`, or agent process survives.
- `POST /api/clone` with `force: true` supersedes a wedged job without a server restart.
- The cost checkpoint pauses, shows a number, and resumes or cancels.
- A reconnecting browser sees any pending gate, for both event types.
- Malformed bodies on `/stop` and `/approve` return 4xx and never crash the process.
- `npx tsc --noEmit` exits 0 and `bash scripts/gate.sh` passes.

## Do not

- No new dependencies — `AbortController` is global in Node 18+.
- Do not build a second gate mechanism; extend Phase 2.1's.
- Do not change the six step names in `server.ts:5-12` or the `line.startsWith` matcher at
  `server.ts:165`; any log line you add keeps its step's prefix.
- Do not start a real clone run to test stop. Test the endpoints and the abort path
  directly.
- Do not touch `sites/`.
