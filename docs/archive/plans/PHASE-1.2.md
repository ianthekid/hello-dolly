# Phase 1.2 — Per-run log file + live cost

**Why now:** job state is in-memory only (`server.ts:22` — `let job: Job | null = null`), so
every failure is undiagnosable after the fact. Landing this before the behavioural phases
means their failures are readable.

## Goal

1. Every run streams its log lines, its error, and its final cost to
   `sites/<domain>/run.log`.
2. `total_cost_usd` is streamed to the UI *live*, not only in the one summary line at the
   end of the rebuild.

## Files / anchors to touch

### `pipeline.ts`

- `runClone` (`pipeline.ts:459`) computes `siteDir` at `:468` and makes `sourceDir` at
  `:470`. Open an append-mode write stream on `path.join(siteDir, 'run.log')` right after
  the `mkdirSync`, and wrap the incoming `onLog` so every line is both forwarded to the
  caller and written to the file with an ISO timestamp prefix.
- The wrapped logger must be the one passed to `mapPages` / `crawlPages` / `captureMobile` /
  `rebuild` / `publishPreview` — i.e. shadow `onLog` for the body of `runClone`.
- Errors: wrap the body so a throw is appended to `run.log` before it propagates, then
  re-throw unchanged (`server.ts:56-59` still needs the original message). Close the stream
  in a `finally`.
- Cost: the `result` message handler at `pipeline.ts:443-451` already reads
  `m.total_cost_usd`. The SDK also reports cost on intermediate messages — accumulate the
  latest known value and emit a cost line at most once every ~30s (or when it changes by
  more than a few cents), so the UI shows spend as it happens.

### SSE prefix contract (read before writing any log line)

`server.ts:5-12` defines the six canonical step names; the UI picks the active step with
`STEPS.findIndex(s => line.startsWith(s))` at `server.ts:165`. Therefore:

- A cost line emitted **during** the rebuild must still start with `Rebuilding site` —
  e.g. `Rebuilding site — $1.42 so far`. A bare `Cost: $1.42` silently resets the UI's
  notion of the active step.
- The same rule applies to cost lines emitted during any other step: keep that step's exact
  prefix.

## Acceptance criteria

- A run (real or `CLONE_DRY_RUN=1`) leaves a readable `sites/<domain>/run.log` containing
  every line the UI received, timestamped.
- A failing run's `run.log` ends with the error text; the UI still receives the same error
  it does today.
- Re-running against the same domain appends rather than truncating (or rotates — either is
  fine, but say which in the commit message).
- `npx tsc --noEmit` exits 0 and `bash scripts/gate.sh` passes.

## Do not

- No new dependencies — `node:fs`'s `createWriteStream` is enough. No logging library.
- Do not break the step-name prefix convention (see above).
- Do not write logs anywhere but under `sites/<domain>/`; `sites/` is gitignored and must
  stay out of commits.
- Do not change the `Job` shape in `server.ts` in a way that breaks the SSE replay at
  `server.ts:235-246`.
