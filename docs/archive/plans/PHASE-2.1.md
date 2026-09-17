# Phase 2.1 — Review gate before the rebuild

**Decision context:** "runs stay unattended" is dead. Unattended runs burn money on the
wrong pages and can't be stopped. This phase pauses the run after crawl/capture and before
the expensive part, and asks a human which pages to build.

## Goal

After capture, the job emits a `review` SSE event listing the selected pages (and what was
filtered, and why). The UI renders checkboxes plus Approve / Cancel. `POST
/api/clone/:id/approve` resumes the run with the selected subset. A browser refresh must
not strand the job.

## Files / anchors to touch

### `pipeline.ts`

- `pipeline.ts:476-479` — the existing `CLONE_DRY_RUN` early return is exactly the right
  hook point. Generalise it: this is where the run pauses.
- `runClone(url, onLog)` (`pipeline.ts:459`) needs a way to ask the caller for approval
  without importing anything from `server.ts` (pipeline must stay server-agnostic —
  `server.ts:50` imports pipeline, never the reverse). Add an **optional** second options
  argument, e.g.
  `runClone(url, onLog, { onReview?: (proposal) => Promise<string[] | null> })`.
  - `onReview` receives the page proposal; it resolves to the approved URL subset, or
    `null`/empty to cancel.
  - When `onReview` is absent, behaviour is unchanged (so `CLONE_DRY_RUN` and any script
    caller keep working). Keep `CLONE_DRY_RUN` working as it does today.
- The proposal should carry, per page: `url`, `title`, whether a screenshot exists. Plus a
  `filtered` list explaining what `pickPages` (`pipeline.ts:66-92`) dropped and why —
  off-host, asset extension, `/feed`/`wp-json`, over the `MAX_PAGES` cap
  (`pipeline.ts:17`), dated-post penalty (`pipeline.ts:85`). `pickPages` currently discards
  its reasons; have it return them alongside the picks, or add a sibling function. Keep
  `pickPages`'s existing signature working if that is cheaper than updating its callers.
- After approval, filter `pages` down to the approved subset before `rebuild`
  (`pipeline.ts:481`). Cancel = return cleanly with a `Cancelled` log line, not a throw.

### `server.ts`

- `Job` (`server.ts:14-20`) gains review state: the pending proposal and the resolver for
  the in-flight `onReview` promise. Keep `lines`, `done`, `error`, `subscribers` as they
  are — the replay path depends on them.
- `startJob` (`server.ts:39-67`) passes an `onReview` that broadcasts
  `broadcast('review', JSON.stringify(proposal))` (`server.ts:24-28`) and returns a promise
  parked until the approve endpoint resolves it.
- **Replay is mandatory.** `server.ts:235-246` replays buffered `log` lines on
  (re)connect, then `done`/`error`. Add: if a proposal is pending, re-emit the `review`
  event after the log replay. A browser refresh mid-gate must re-render the checkboxes,
  not hang on a job that is waiting for a click nobody can make.
- New route `POST /api/clone/:id/approve`, alongside the events route
  (`server.ts:222-252`). Body: `{ urls: string[] }` — or an explicit cancel. Behaviour:
  - unknown / mismatched id → 404, matching `server.ts:225-229`;
  - no pending review → 409;
  - bad JSON or a non-array `urls` → 400, matching the existing style at
    `server.ts:199-210`;
  - any URL not in the proposal → 400. Never trust the body to widen the page set.
  - Success → 200, resolve the parked promise, and log so the UI advances.
- UI (`server.ts:78-185`, the inline `PAGE` string): handle `es.addEventListener('review')`
  by rendering a checkbox list (all checked by default) with Approve and Cancel buttons that
  `fetch` the approve endpoint. Show the filtered list read-only so the operator can see
  what was dropped. Hide the panel once approved. Plain DOM, same style as the rest of the
  page.

## SSE prefix contract

`STEPS` at `server.ts:5-12` and the matcher at `server.ts:165` are unchanged by this phase.
Any log line you emit while waiting must keep the prefix of the step it belongs to —
`Capturing design — awaiting review…` is correct; `Waiting for approval` silently resets the
UI's active step. The `review` event is a **new event type**, not a log line; the log
matcher must not see it.

## Acceptance criteria

- `CLONE_DRY_RUN=1` behaves exactly as before.
- With no `onReview` supplied, `runClone` runs end to end as it does today.
- Through the UI: a job pauses after capture, shows the page list, and only rebuilds the
  checked subset.
- Refreshing the browser during the gate re-renders the gate.
- Cancel ends the job cleanly — no rebuild, no orphaned promise, `done` fires.
- A forged approve body (extra URL, wrong id, malformed JSON) is rejected with the right
  status and does not crash the process.
- `npx tsc --noEmit` exits 0 and `bash scripts/gate.sh` passes.

## Do not

- No new dependencies. Node's `http` + the existing inline HTML. No express, no framework,
  no client-side library.
- Do not make `pipeline.ts` import from `server.ts`.
- Do not change the six step names.
- Do not start a real clone run to test. Exercise the gate with `CLONE_DRY_RUN`-style
  stubbing or a unit-level call; a real run costs money and network.
- Do not touch `sites/`.
