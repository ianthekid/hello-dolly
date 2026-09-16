# Phase 1.4 — Export completeness check + `serve.ts` spawn hygiene

Two fixes to the tail of a run: don't ship a partial site, and don't orphan a server.

## Goal A — export completeness

Verify every page in `pages.json` has a built file in `app/out/` **before** the preview is
published. Real failure: on ianray.com a parallel page-builder wrote its page 4 minutes
after the export ran — we shipped 10 of 11 pages and nothing noticed.

### Files / anchors

- `pipeline.ts:483-492` — the tail of `runClone`, between `rebuild(...)` and
  `serve.publishPreview(appDir, onLog)`.
- The route→file mapping mirrors what the orchestrator was told to build
  (`pipeline.ts:364-366`: original pathname `/services/service` →
  `src/app/services/service/page.tsx` → `out/services/service.html` or
  `out/services/service/index.html`). Accept either export shape.
- The home page is `out/index.html`.
- `serve.publishPreview` itself runs `next build` (`serve.ts:44-56`), which is what produces
  `app/out/`. So the check cannot run before the build. Split it: either export a
  build-only step from `serve.ts` and check between build and serve, or have
  `publishPreview` take an optional verify callback invoked after `next build` succeeds
  (`serve.ts:56`) and before the `npx serve` spawn (`serve.ts:72`). Pick the smaller diff.
- On a mismatch: log which routes are missing, wait ~30s, re-check once (a late subagent
  write is the common cause), then re-run the export. If it is still short, throw with the
  missing route list — failing loud is the point.

## Goal B — `serve.ts` spawn hygiene

Both spawns can fail silently, and `stop` kills the wrong process.

### Files / anchors

- `serve.ts:47` — `spawn("npx", ["next", "build"], { cwd: appDir })`. No `'error'`
  handler, so an ENOENT never resolves the promise and the run hangs forever. Add an
  `'error'` handler that rejects/resolves with a non-zero code, and a timeout (build is the
  long one — 10 min is a reasonable ceiling; kill the child on timeout).
- `serve.ts:72-78` — `spawn("npx", ["serve", "out", …], { detached: true })` then
  `writeFileSync(pidFile, String(child.pid))`. **`child.pid` is the `npx` wrapper's PID**,
  not the server's. `process.kill` on it (`serve.ts:63`, `serve.ts:96`) reaps the wrapper
  and orphans the server holding the port — which is why ports stay wedged.
  - Fix: spawn detached with `detached: true` so the child leads its own process group, and
    record/kill the **group** (`process.kill(-pid, …)`), or resolve the real server PID
    before writing the pid file. Keep the pid-file path and format
    (`serve.ts:6` `PID_NAME`, `serve.ts:91`) so `npm run previews:stop` keeps working.
  - Add an `'error'` handler here too — an ENOENT currently shows up as
    `waitFor200` timing out after 15s (`serve.ts:81`) with a misleading message.
- `serve.ts:8-15` `isAlive` and the stop path at `serve.ts:86-107` must stay consistent with
  whatever identifier you store (pid vs. negative pgid). If you store a pgid, say so in the
  pid file or in a comment — a future reader must not guess.

## Acceptance criteria

- A run missing a page never reaches `publishPreview`; it logs the missing routes and
  either recovers or throws with them named.
- `npm run previews:stop` frees the port: after it runs, nothing is listening on the
  preview port and the pid file is gone.
- A spawn of a nonexistent binary surfaces a clear error within seconds, not a 15s or
  infinite hang.
- `npx tsc --noEmit` exits 0 and `bash scripts/gate.sh` passes.

## Do not

- No new dependencies. `node:child_process` and `node:fs` only — no `execa`, no `tree-kill`.
- Keep the `Publishing local preview` prefix on every log line from this area
  (`pipeline.ts:484`, `:492`, `serve.ts:45`, `:56`, `:82`). The UI's last step depends on it.
- Do not start a preview server as part of testing this phase, and never bind 3999.
- Do not modify, move, or delete anything under `sites/`.
