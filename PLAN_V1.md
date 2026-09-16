# PLAN_V1 — Post-PoC roadmap (toward repaint.com parity)

Prereq: PoC/MVP from PLAN.md complete (URL in → local clone URL out).

Rewritten after a post-mortem of 3 real runs (ianray.com, comatica, +1). The old v1
list assumed the pipeline was reliable and unattended. It isn't, and it shouldn't be.
v1 is now 4 phases: fix what's broken + cheap token wins, then a review gate, then
the big token win, then everything else.

**Business context:** we take over client sites from SEO agencies holding them hostage
on WordPress/Wix. The sale hinges on the client trusting that nothing was lost and
rankings won't drop — so the parity report (Phase 4 #1) is the flagship deliverable,
and redirects/SEO parity are ranking insurance, not nice-to-haves.

**Decision reversal:** "in-run human confirmation gates — runs stay unattended" is
dead. Unattended runs burn money on the wrong pages and can't be stopped. Phase 2 adds
gates on purpose.

## Phase 1 — Reliability + cheap token wins (prerequisites)

Nothing else is worth building until a run is diagnosable and its output is complete.

- **Export completeness check.** Orchestrator verifies every page in `pages.json` has a
  file in `app/out/` *before* build/export. Real failure: on ianray.com a parallel
  page-builder subagent wrote its page 4 min after export ran — we shipped 10/11 pages
  and nothing noticed. Fail loud, or wait and re-export.
- **serve.ts spawn hygiene.** Both spawns get `'error'` handlers + a timeout. Record the
  *real* server PID, not the `npx` wrapper's — today stop kills the wrapper and orphans
  the server holding the port.
- **Explicit, invalidatable pages.json cache.** `crawlPages` silently reuses stale cache
  and ignores fresh page selection (comatica's cache is leftover `spike.ts` output).
  Cache key must include the crawl inputs; add a force-recrawl flag.
- **Per-run log file.** Stream logs + errors + final cost to `sites/<domain>/run.log`.
  Job state is in-memory only today, so every failure is undiagnosable after the fact.
- **Token wins** (all cheap, all independent):
  - QA subagent Opus → Sonnet, and drop its visual screenshot re-read (keep the
    `next build` + grep checks — those are what actually caught things).
  - `onlyMainContent: true` for non-home pages.
  - Subagents `Read` design-tokens.md from disk instead of receiving it pasted inline.
  - `maxTurns` 800 → 200, and set `maxThinkingTokens`.
  - Stream `total_cost_usd` live to the UI.

## Phase 2 — Review gate + stop

- **Review gate before the rebuild.** Pause after crawl/capture, before the expensive
  part — reuse the existing `CLONE_DRY_RUN` hook point (pipeline.ts ~:476). Push a
  `review` SSE event with the selected page list plus what was filtered and why; UI
  renders checkboxes + Approve/Cancel; `POST /api/clone/:id/approve` resumes with the
  selected subset.
  - SSE replay must re-emit a pending `review` event on reconnect — a browser refresh
    must not strand the job.
- **Stop button.** `AbortController` threaded through `runClone` → `query()` options
  (the SDK supports it), `POST /api/clone/:id/stop`, signal forwarded to serve.ts
  spawns. Also: a `force` flag on the 409 so a wedged job doesn't need a server restart.
- **Cost checkpoint before QA.** "Build done, QA will cost ~$X — proceed?"

## Phase 3 — Screenshot tiling (biggest token win, ~25–40%)

- Pre-slice full-page screenshots into viewport-height tiles **at capture time**. Today
  the agent invents its own ffmpeg cropper and then re-reads 5–6 crops per page — we pay
  for the invention and for the re-reads.
- Scaffold the Next.js config files (`next.config`, `tailwind.config`, `tsconfig`,
  `package.json`) in plain code. Opus typing boilerplate is the dumbest token we spend.

## Phase 4 — v2 seeds (defer)

Not until 1–3 are done and a run is boring.

- Richer selection UI: content types, per-section include/exclude.
- Multi-job queue + persistence (SQLite) instead of one in-memory job; auth; run in
  Docker (Railway/Fly) instead of the Mac.
- **Migration parity report** (flagship client-facing artifact): URL inventory
  (crawl + their `/sitemap.xml`) with each URL's route in the clone, image manifest with
  alt text, per-page content inventory (word counts, headings, phone/address/email
  verified present), SEO parity table (title/description/OG/canonical/JSON-LD, ✓/✗),
  redirect map → `_redirects`. Mostly a rendering pass over `pages.json` +
  site-analysis.json.
- **site-analysis.json contract**: one analyzer pass writes
  `{ designTokens, sharedChrome, pageMap, sectionInventory }` before builders fan out.
  Prereq for the parity report, redesign mode, and form detection.
- **Scored visual-diff fix loop**: screenshot clone at source viewports, score 0–100
  (layout 25 / colors 20 / type 15 / spacing 15 / content 15 / responsive 10), fix top
  diff and re-score, max 3 iterations. Note this fights Phase 1's "drop the QA
  screenshot re-read" — only revisit once tiling (Phase 3) makes images cheap.
- **Mobile source screenshots**: 390px viewport per page; feed both PNGs to builders.
- **SEO/meta parity**: carry title/description/OG/canonical/JSON-LD, generate
  sitemap.xml + robots.txt, preserve URL paths exactly, 301 anything that moves.
- **Asset localization**: download hot-linked images into `public/`, rewrite srcs.
- **Chat-based editing** of a finished clone (`query()` with `resume`, per-clone git
  repo for free undo) — the actual product after the PoC.
- **Public publishing**: `wrangler pages deploy out/`, subdomain per clone.
- **Forms that work**: relay to Cloudflare Pages function / Formspree.
- **Redesign mode**: same pipeline, swap the designTokens input, offer 2–3 variants.

## Explicitly not doing

- Buildmate's DOM-heuristic component/API detection — Firecrawl md + screenshots cover it.
- Multi-framework output (Vue/Svelte/RN) — Next.js/Tailwind only.
- CMS/WordPress content sync — revisit only if a client demands it.
