# PLAN_V1 — Post-PoC roadmap (toward repaint.com parity)

Prereq: PoC/MVP from PLAN.md complete (URL in → local clone URL out).

Rewritten after a post-mortem of 3 real runs (ianray.com, comatica, +1). The old v1
list assumed the pipeline was reliable and unattended. It isn't, and it shouldn't be.
v1 is now 4 phases: fix what's broken + cheap token wins, then a review gate, then
the big token win + ops polish, then hosted mode. Everything else is v2 seeds.

**Business context:** we take over client sites from SEO agencies holding them hostage
on WordPress/Wix. The sale hinges on the client trusting that nothing was lost and
rankings won't drop — so the parity report (first item under "Later — v2 seeds") is the
flagship deliverable, and redirects/SEO parity are ranking insurance, not nice-to-haves.

**Decision reversal:** "in-run human confirmation gates — runs stay unattended" is
dead. Unattended runs burn money on the wrong pages and can't be stopped. Phase 2 adds
gates on purpose.

## Phase 1 — Reliability + cheap token wins (prerequisites)

**Status: DONE 2026-09-16** (1.1–1.5 committed).

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

**Status: DONE 2026-09-16** (2.1–2.2 committed).

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

## Phase 3 — The big token win + ops polish

Three phase files, in order: `docs/plans/PHASE-3.1.md`, `-3.2.md`, `-3.3.md`.

- **3.1 — Screenshot tiling at capture.** Pre-slice full-page screenshots into
  viewport-height (~1080px) tiles **at capture time**, into `source/tiles/<page>-N.png`
  next to the full PNG, and hand the tile list to the orchestrator and page-builders.
  Today a 1920×6863 PNG is downscaled to unreadable, so the agent invents its own ffmpeg
  cropper every run and then re-reads 5–6 crops per page — we pay for the invention *and*
  for the re-reads (~25–40% of a run's tokens). The one permitted new dep is `sharp`;
  nothing else in the tree can decode a PNG.
- **3.2 — Scaffold in code, not prose.** `package.json`, `next.config.ts`,
  `postcss.config.mjs` and `tsconfig.json` are fully specified inside the orchestrator
  prompt, then retyped by Opus every run. Write them from `pipeline.ts` before the agent
  session starts; the prompt just says the scaffold exists. Opus typing boilerplate is the
  dumbest token we spend.
- **3.3 — UI/ops polish.** Four small, independent fixes, all found in real runs:
  - running-previews list in the UI (domain, port, Stop button) — today a stale preview is
    only killable from the CLI;
  - the rebuild log prints "Rebuilding site — done in Ns ($X)" once per finished
    page-builder; only the terminal result should say "done";
  - live cost appears once at the end instead of ticking during the rebuild;
  - one retry with backoff on Firecrawl fetches — a transient `fetch failed` killed a real
    run on 2026-09-16.

## Phase 4 — Hosted mode

One phase file: `docs/plans/PHASE-4.1.md`. One runbook: `docs/HOSTED.md`.

The tool stops being a thing on the Mac. It runs permanently on the droplet behind nginx on
Ian's domain, so viewing a finished clone never means pulling `sites/` down to a laptop.

- **4.1 — the code half.** A `HOSTED=1` switch. In hosted mode `publishPreview` still builds
  and verifies the static export but does **not** spawn `npx serve` — nginx serves
  `sites/<domain>/app/out/` at `/preview/<domain>/`, so there is no per-preview port,
  process or pid file. Local Mac behaviour is untouched; hosted is a mode, not a
  replacement.
  - Subpath serving is the real problem: a Next static export addresses everything from the
    site root. Decision: in hosted mode bake `basePath: '/preview/<domain>'` into the
    generated `next.config.ts` (Next then prefixes chunks, CSS, fonts, `<Link>` and the
    client chunk loader), plus a small deterministic post-export pass that prefixes the raw
    `public/` references the page-builders write (`<img src="/logo.png">`). nginx-side
    rewriting can't work — a `/_next/...` request carries no hint of which clone it belongs
    to — and a subdomain per clone would need wildcard DNS plus a wildcard cert. Rationale
    in full in the phase file.
- **The ops half is manual.** nginx server block (proxy to 127.0.0.1:3999, SSE location with
  `proxy_buffering off`, a single regex `location` over `sites/*/app/out`), mandatory
  basic-auth, certbot, ufw closing 3999 and the old preview port range, and a systemd unit
  so the UI survives a reboot with its env from `.env.hosted`. All of it is in
  `docs/HOSTED.md` and **Ian applies it by hand** — no agent runs it, and none of it is
  checked into the repo.

## Later — v2 seeds (defer)

Not until 1–4 are done and a run is boring.

- Richer selection UI: content types, per-section include/exclude.
- Multi-job queue + persistence (SQLite) instead of one in-memory job. (Phase 4 covers the
  "not on the Mac" and "auth" parts — the droplet plus nginx basic-auth — so what's left
  here is genuinely the queue and the persistence.)
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
