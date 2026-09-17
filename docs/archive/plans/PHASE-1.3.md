# Phase 1.3 — Explicit, invalidatable `pages.json` cache

**The bug:** `crawlPages` reuses `source/pages.json` if the file merely exists
(`pipeline.ts:101-106`), regardless of which URLs were selected. comatica's cache is
leftover `spike.ts` output, so a fresh page selection is silently ignored and the run
rebuilds the wrong pages.

## Goal

The crawl cache is keyed on its inputs and can be forced to invalidate.

## Files / anchors to touch

### `pipeline.ts`

- `crawlPages(urls, sourceDir, onLog)` — `pipeline.ts:96-145`.
  - `pipeline.ts:101-106` is the offending early return. Replace the bare `existsSync`
    check with a keyed one.
  - Change the on-disk shape to a wrapper, e.g.
    `{ key, crawledAt, pages: Page[] }`, written at `pipeline.ts:143`. Reuse the cache only
    when the stored `key` matches the key computed from the current inputs.
  - The key must cover the crawl inputs: the sorted selected URL list, `MAX_PAGES`
    (`pipeline.ts:17`), and the `formats` / `onlyMainContent` options passed to
    `/batch/scrape` at `pipeline.ts:109-113`. A short hash (`node:crypto` `createHash`) of a
    canonical JSON string is fine.
  - A cache file in the **old** bare-array format is by definition unkeyed — treat it as a
    miss and recrawl. Do not attempt to migrate it.
  - Add a force-recrawl escape hatch: `process.env.CLONE_FORCE_RECRAWL` (any truthy value)
    skips the cache entirely and overwrites. Mention it in the log line.
- `runClone` at `pipeline.ts:473` passes `pickPages(target, links)` into `crawlPages` — that
  selected list is the thing the key must reflect.

### Log lines

Keep the `Extracting content` prefix on every line from this function
(`pipeline.ts:104`, `:108`, `:119`, `:140`). The UI matches on it
(`server.ts:5-12`, `server.ts:165`). Good lines:

- `Extracting content — reusing cached crawl (11 pages, key a1b2c3)`
- `Extracting content — cache miss (page selection changed), recrawling 14 pages…`
- `Extracting content — forced recrawl (CLONE_FORCE_RECRAWL set)`

## Acceptance criteria

- Two runs with identical inputs: the second reuses the cache and says so.
- A run whose selected URL list differs by even one URL recrawls.
- `CLONE_FORCE_RECRAWL=1` always recrawls.
- A pre-existing bare-array `pages.json` causes a recrawl, not a crash.
- Everything downstream still receives a plain `Page[]` — the wrapper is an on-disk detail,
  and `captureMobile` (`pipeline.ts:149`) plus `orchestratorPrompt` (`pipeline.ts:285`) are
  unchanged.
- `npx tsc --noEmit` exits 0 and `bash scripts/gate.sh` passes.

## Do not

- No new dependencies — `node:crypto` is built in. No hashing library.
- Do not change `pickPages` (`pipeline.ts:66`) or its scoring heuristic; page *selection* is
  out of scope for this phase.
- Do not delete or rewrite anything already under `sites/` — those are real client runs.
- Do not break the step-name prefix convention.
