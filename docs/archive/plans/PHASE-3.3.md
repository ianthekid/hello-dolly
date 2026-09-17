# Phase 3.3 — UI/ops polish

Four independent fixes, all found in real runs. They share no code; land them together but
keep them separable — if one turns out to be bigger than it looks, ship the other three and
say so in the commit message.

## (a) Running-previews list in the UI

**Today:** `publishPreview` leaves a detached preview server per cloned site, recorded in
`sites/<domain>/app/serve.pid` (`serve.ts:10`, written at `serve.ts:183`). The only way to
see or stop one is `npm run previews:stop` (`package.json:8` → `serve.ts:191-212`), which
stops *all* of them from a terminal. The UI knows nothing about them.

**Goal:** the UI lists every live preview — domain, port, clickable URL — with a Stop
button per row that kills that preview's process group and removes the stale pid file.

### `serve.ts`

- The pid file records only the pgid, so the port is unrecoverable. Change what gets
  written at `serve.ts:180-183` to JSON: `{ pgid, port, startedAt }` (the port is already
  in scope from `freePort(4321)` at `serve.ts:138`). Keep the filename `serve.pid` and keep
  the comment at `serve.ts:6-9` — the stored number is still a **pgid**, and every kill
  still goes through `killGroup` / `process.kill(-pgid, …)` (`serve.ts:24-26`). Killing the
  bare pid reaps the `npx` wrapper and orphans the `serve` process holding the port.
- Add `readPidFile(file): { pgid: number; port: number | null } | null` and use it in
  **both** existing readers — the stale-preview kill at `serve.ts:125-136` and the `stop`
  CLI at `serve.ts:196-208`. It must tolerate the **legacy bare-number format**: real sites
  on the VPS have pid files written by the current code, and `Number('{"pgid":123,…}')` is
  `NaN`, which would silently stop killing anything. Bare number → `{ pgid, port: null }`.
- Export two helpers so `server.ts` does not reimplement the scan:
  - `listPreviews(root?: string): { domain: string; pgid: number; port: number | null; url: string | null; alive: boolean }[]`
    — walks `sites/*/app/serve.pid` the way `serve.ts:194-209` already does, uses
    `isAlive` (`serve.ts:15-22`), and **removes the pid file for entries that are not
    alive** (a dead pid file is exactly the "stale file" the Stop button is meant to clean
    up). Only live entries are returned.
  - `stopPreview(domain: string, root?: string): boolean` — kill the group, remove the pid
    file, return whether anything was actually killed.
- Rewrite the `stop` CLI block (`serve.ts:191-212`) in terms of those two helpers so there
  is one implementation, not two. Keep its console output and the "no live previews found"
  line. **Keep the `process.argv[2] === "stop"` guard** — that block is top-level and must
  stay inert when `serve.ts` is imported.

### `server.ts`

- `GET /api/previews` → `200` with the `listPreviews()` array. Add it alongside the other
  routes in the `createServer` handler (`server.ts:447-662`), before the 404 fallback at
  `server.ts:660-661`.
- `POST /api/previews/:domain/stop` → `200 { ok: true }` on a kill, `404` if that domain
  has no live preview. Follow the existing route style: a `url.pathname.match(...)` regex
  like `server.ts:631` and the same JSON error shapes.
  - **Validate the domain.** `decodeURIComponent` it, then require it to be a member of the
    set returned by `listPreviews()`. Never build a path out of the request and stat it —
    `../../` in a path segment must not be able to reach outside `sites/`.
- Import `serve.ts` the way `server.ts:109` imports the pipeline — `await import('./serve.js')`
  inside the handler — so a broken `serve.ts` cannot stop the UI from booting (the gate
  boots this server, `scripts/gate.sh:44-57`).
- UI (`PAGE`, `server.ts:139-445`): add a `#previews` section under the log
  (`server.ts:168-177` is the markup block) rendered by a `refreshPreviews()` that
  `fetch`es `/api/previews` and builds rows with plain DOM, matching the style of
  `renderReview` (`server.ts:251-329`). Each row: `domain — http://localhost:PORT` as an
  `<a target="_blank">`, plus a Stop button that POSTs and then calls `refreshPreviews()`.
  Call it on page load, and again from the `done` handler (`server.ts:378-386`) so a
  finished run's new preview appears. Empty list → hide the section.
- **Preview auto-launch at the end of a run stays exactly as it is** — `runClone` still
  calls `publishPreview` at `pipeline.ts:692`. This is a list-and-stop feature, not a
  launcher.

## (b) Rebuild log prints "done" once per page-builder

**Today:** a rebuild emits several `Rebuilding site — done in Ns ($X)` lines. The `result`
branch at `pipeline.ts:535-547` treats **every** `m.type === 'result'` message as the
session's final result, but the SDK also yields a `result` for each finished subagent
(`page-builder`, `qa` — the `agents` map at `pipeline.ts:507-518`). Each page-builder
completion therefore re-broadcasts a "done" line, and worse, the `subtype !== 'success'`
throw at `pipeline.ts:540-542` means **one failed page-builder aborts the whole rebuild**.

**Fix:** only the terminal result reports done, and only the terminal result can throw.

- Inside the `result` branch, classify the message. Nested subagent messages carry a
  non-null `parent_tool_use_id`; the session's own result does not. Gate on that if the
  field is present on the messages this SDK version emits — **check the actual stream
  before relying on it**, do not assume.
- Regardless of what that check finds, make the reporting structurally correct: keep a
  `let finalResult` and emit the `Rebuilding site — done in …` line (and do the
  `subtype !== 'success'` throw) **after** the `for await` loop ends, in place of doing it
  inside the loop. The stream's last result is the session result by definition, so this is
  right whether or not `parent_tool_use_id` exists.
- A nested non-success result is worth one log line (e.g.
  `Rebuilding site — a page builder ended with "<subtype>"`) — it is real information — but
  it must not throw and must not say "done".
- The repeat-collapsing `log()` at `pipeline.ts:473-477` does not help here: these lines
  differ (different durations and costs), which is why they all got through. Do not try to
  fix this by widening the repeat collapser.
- Keep the QA-marker path (`pipeline.ts:524-531`) and the
  `if (!qaStarted)` fallback at `pipeline.ts:553` working.

## (c) Live cost does not tick during the rebuild

**Today:** `latestCost` (`pipeline.ts:482`) is only assigned inside the `result` branch
(`pipeline.ts:536-539`), and the 30s `costTimer` (`pipeline.ts:489-491`) only emits when
`latestCost` has changed. If the subagent `result` messages carry no `total_cost_usd`, that
value stays `0` for the entire rebuild and the one and only cost line is the summary at the
end — which is exactly what operators see. Note this is the same observation as (b) from
the other side: the nested results *are* arriving, they just aren't carrying cost.

**Investigate first, then pick:**

1. Log the shape of every message the `for await` loop at `pipeline.ts:520` receives during
   a short rebuild (type, `parent_tool_use_id`, `total_cost_usd`, `usage`). Do this against
   a captured/recorded stream or a trivial local prompt — **not** a real clone run.
2. If nested `result` messages *do* carry `total_cost_usd`: accumulate them into a running
   subtotal, and display `max(subtotal, terminal total_cost_usd)` so the number only ever
   moves forward. The terminal value is authoritative.
3. If they do not, the only per-message signal is `usage` on `assistant` messages
   (input / output / cache-read / cache-write tokens, plus the model). Then either:
   - keep dollars and add one small dated constant mapping the two models in use
     (`opus` at `pipeline.ts:499`, `sonnet` at `:510`/`:515`) to per-MTok prices — mark the
     streamed figure as approximate (`Rebuilding site — ~$1.42 so far`) and let the exact
     `total_cost_usd` supersede it at the end; **or**
   - stream cumulative **tokens** instead (`Rebuilding site — 1.2M tokens so far`) and keep
     dollars exact-only at the end.
   Prefer the token line if you are not confident in the prices. A wrong dollar figure is
   worse than an honest token count; a hard-coded price table that silently rots is the
   thing to avoid.
4. Keep the existing emit cadence (`pipeline.ts:484-491`): at most every ~30s, or on a
   jump of a few cents, whichever comes first, and keep the `clearInterval` in the
   `finally` at `pipeline.ts:549-551`.

## (d) One retry with backoff on Firecrawl fetches

**Today:** a single transient `fetch failed` kills the run. That happened for real on
2026-09-16, after the crawl had already been paid for.

- Add a small `fetchRetry(url, init, label)` helper near `firecrawl`
  (`pipeline.ts:31-42`) and route all three Firecrawl call sites through it:
  - `firecrawl()` itself (`pipeline.ts:32-36`) — `/map` (`:56`), `/batch/scrape`
    (`:189`, `:193`), `/scrape` (`:241`);
  - the poll `fetch` in `pollBatchJob` (`pipeline.ts:149`);
  - the screenshot download in `saveImage` (`pipeline.ts:48`).
- Policy: **one** retry after ~2s. Retry when the `fetch` promise *rejects* (no response at
  all — `TypeError: fetch failed`, DNS, reset) and on `429` / `5xx`. Never retry a `4xx`
  other than `429`: a bad key or a bad URL will fail identically the second time and the
  error message is what the operator needs.
- `/batch/scrape` is a POST and therefore not strictly idempotent — a retry could start a
  duplicate Firecrawl job. Accept that: when the fetch rejected, no job handle ever came
  back, so there is nothing to poll and nothing to salvage; a duplicate job costs credits,
  a dead run costs the whole crawl. Put that reasoning in a comment at the helper.
- Log the retry so it is visible in `run.log`, with the prefix of the step it happens in —
  `Extracting content — Firecrawl /batch/scrape failed (fetch failed), retrying in 2s…`.
  The helper does not know the step, so pass the prefix (or the whole label) in from the
  call site.
- Keep the backoff short (~2s): `runClone`'s abort checks (`assertNotAborted`,
  `pipeline.ts:608-610`, called at `:641`/`:644`/`:646`) only run between stages, so a long
  sleep here delays the Stop button by that much.

## SSE prefix contract

`STEPS` (`server.ts:5-12`) and the matcher at `server.ts:366`
(`STEPS.findIndex(s => line.startsWith(s))`) are unchanged by this phase. Every new log
line must start with the exact name of the step it belongs to: retry lines during the crawl
start with `Extracting content` (or `Capturing design` for the mobile `/scrape` at
`pipeline.ts:241`), cost and done lines start with `Rebuilding site`. Do not rename,
reorder or add to `STEPS`.

The previews list is **not** a job log — it is a plain REST endpoint plus its own DOM
section. Do not push preview state through `jobLog` (`server.ts:38-41`), do not invent a
new SSE event for it, and do not let it write into `job.lines` (the replay buffer at
`server.ts:500-502` depends on those being job log lines only).

## Acceptance criteria

- `GET /api/previews` returns `200` and a JSON array when no previews are running (empty
  array, not an error), and the gate's "unknown routes 404" check
  (`scripts/gate.sh:77-79`) still passes.
- `POST /api/previews/<unknown-domain>/stop` returns `404`; a path segment containing
  `..` or a slash is rejected, not resolved.
- `serve.ts stop` still works against a **legacy bare-number** `serve.pid` and against the
  new JSON one.
- A rebuild prints `Rebuilding site — done in …` exactly once, and a failed subagent does
  not abort the run.
- Cost (or token) progress appears at least once per ~30s during a rebuild, always with the
  `Rebuilding site` prefix, and the final exact figure still lands at the end.
- A Firecrawl call that rejects once and succeeds on retry completes the run and leaves a
  retry line in `run.log`; a `401` is not retried.
- `npx tsc --noEmit` exits 0 and `bash scripts/gate.sh` passes.

## Do not

- No new dependencies. `node:http`, `node:fs`, `node:child_process`, global `fetch` and the
  existing inline HTML cover all four items. No express, no p-retry, no client-side
  library, and do not edit `package.json`.
- Do not change the six step names or break the step-name prefix convention.
- Do not make `pipeline.ts` import from `server.ts` (`server.ts:109` imports the pipeline;
  never the reverse). `serve.ts` may be imported by both.
- Do not change when the preview auto-launches — `publishPreview` at the end of `runClone`
  (`pipeline.ts:684-693`) stays exactly as it is.
- Do not kill a preview by bare pid. Every kill goes through the negative-pgid path
  (`serve.ts:24-26`) or it orphans the process holding the port.
- Do not add a retry loop around the *agent* session (`pipeline.ts:494`) — item (d) is
  about Firecrawl HTTP calls only. Re-running a failed rebuild is a decision for a human.
- Do not start a real clone run, a preview server, or `next build` to test any of this.
  `CLONE_DRY_RUN=1` exercises the Firecrawl path; the previews list can be tested against a
  fake `serve.pid` written under `/tmp` with a `sleep`'s pgid in it.
- Do not write into `sites/`.
