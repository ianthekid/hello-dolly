# Phase 1.5 — Token wins

Five independent, cheap reductions. All in `pipeline.ts`. Land them together; each is a
few lines.

## The five changes

### 1. QA subagent: Opus → Sonnet, drop the visual screenshot re-read

- `pipeline.ts:421-425` — the `qa` agent definition, currently `model: 'opus'`. Change to
  `'sonnet'`.
- `pipeline.ts:262-283` — `qaPrompt`. Delete checklist items **3** (`Read its
  source/<name>.png next to the page code…`) and **4** (the mobile screenshot comparison).
  Keep items 1, 2, 5, 6, 7 — the `next build` and grep checks are what actually caught
  things. Keep the port-4998 rule at `pipeline.ts:280-281` verbatim; 3999 must stay
  reserved for the UI.
- Update the "Report:" line so it no longer promises a visual verdict it no longer makes.

### 2. `onlyMainContent: true` for non-home pages

- `pipeline.ts:109-113` — the `/batch/scrape` call currently sends
  `onlyMainContent: false` for the whole batch. The home page genuinely needs full chrome
  (nav + footer are extracted from it); inner pages do not.
- Firecrawl's batch endpoint applies one options object to all URLs, so split into two
  calls — home with `onlyMainContent: false`, the rest with `true` — and merge the results
  before the write at `pipeline.ts:126-144`. Poll both jobs (the polling loop is
  `pipeline.ts:115-121`); factor it into a helper rather than duplicating it.
- "Home" = the URL whose `slug()` (`pipeline.ts:19-22`) is `home`.

### 3. Subagents `Read` design-tokens.md from disk

- `pipeline.ts:367` — the orchestrator is told to paste *"the FULL contents of
  `source/design-tokens.md`"* into every page-builder delegation. With N pages that file is
  paid for N times.
- Change it to instruct the orchestrator to pass the **path**
  (`source/design-tokens.md`) and require the builder to `Read` it.
- Mirror the change in `pageBuilderPrompt` (`pipeline.ts:237-260`): its input list at
  `:239-240` says it *receives* the design-tokens note — change that to "read
  `source/design-tokens.md` with the Read tool before you write anything", and keep the
  "use ONLY those tokens" rule at `:246-249` intact.

### 4. `maxTurns` 800 → 200, and set `maxThinkingTokens`

- `pipeline.ts:414` — `maxTurns: 800`. Set to `200`.
- Add `maxThinkingTokens` to the same options object (`pipeline.ts:410-427`). Pick a
  deliberate value and leave a one-line comment saying why.

### 5. Stream `total_cost_usd` live to the UI

- If Phase 1.2 already landed live cost streaming (`pipeline.ts:443-451`), this item is
  done — verify it and say so in the commit message rather than duplicating it.

## Acceptance criteria

- `qa` runs on Sonnet; `qaPrompt` no longer asks for any PNG read; the build + grep checks
  and the port-4998 rule survive.
- Home is scraped with full chrome, inner pages with `onlyMainContent: true`, and the
  merged `pages.json` still lists every selected page exactly once.
- No prompt in `pipeline.ts` instructs anyone to paste file contents inline.
- `maxTurns` is 200 and `maxThinkingTokens` is set.
- `npx tsc --noEmit` exits 0 and `bash scripts/gate.sh` passes.

## Do not

- No new dependencies.
- Do not change the `page-builder` model (`pipeline.ts:419`) — it is already Sonnet.
- Do not touch the orchestrator's own `model: 'opus'` (`pipeline.ts:412`). Downgrading the
  orchestrator is not part of this plan.
- Do not weaken the "screenshots are the spec / markdown is the content / no hot-linking"
  rules (`pipeline.ts:308-322`). This phase cuts *repetition*, not *requirements*.
- Keep the `Extracting content` prefix on every scrape log line and the `QA_MARKER`
  mechanism at `pipeline.ts:235`, `:380`, `:432-438` working — that marker is how the UI
  learns step 5 started.
- Do not start a real clone run to test this. `CLONE_DRY_RUN=1` exercises the scrape path
  and costs no agent tokens.
