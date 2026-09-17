# HISTORY — how this tool got here, and why it is the way it is

Context for agents working on v2+. The build-phase scaffolding that produced v1 lives in
`docs/archive/` (original plans, phase work orders, the VPS phase driver, the Phase-0
spike). This file is the distillation: the decisions, the failures that forced them, and
the roadmap seeds. Read this before proposing changes that "simplify" something — most of
the odd-looking constraints below were paid for with a real broken run.

## What the product is

URL in → AI-maintainable Next.js/Tailwind clone out, watched from a one-page web UI.

**Business context:** we take over client sites from SEO agencies holding them hostage on
WordPress/Wix. The sale hinges on the client trusting that nothing was lost and rankings
won't drop. So the **migration parity report** (see v2 seeds) is the flagship
deliverable, and redirects/SEO parity are ranking insurance, not nice-to-haves.

## Stack decisions (from the original PoC plan)

| Layer | Choice | Why |
|---|---|---|
| Pipeline brain | Claude Agent SDK (`query()`) | every tool-use event maps to a UI log line for free |
| Extraction | Firecrawl API | site → markdown + page map + screenshots, no scraper code |
| Rebuild target | Next.js + Tailwind, static export | agent-friendly, deployable anywhere |
| Progress → browser | SSE, one `EventSource` | one-way push, auto-reconnect, no websockets |
| Rebuild fan-out | orchestrator (Opus) + one page-builder subagent per page (Sonnet) + QA pass (Sonnet) | judgment where it matters, cheap parallelism where it doesn't |

Deliberately three source files, no framework, no build step, in-memory single-job state.

## The post-mortem that shaped v1

After 3 real runs (ianray.com, comatica, +1) the "reliable and unattended" assumption
died. Each failure below is now a guard in the code — don't remove the guard without
knowing its story:

- **Export race (ianray.com):** a parallel page-builder wrote its page 4 minutes *after*
  export ran; we shipped 10/11 pages and nothing noticed. → export completeness check
  before publishing (`verifyExport`).
- **Stale cache (comatica):** `crawlPages` silently reused leftover spike output and
  ignored fresh page selection. → cache keyed on crawl inputs + force-recrawl flag.
- **Orphaned previews:** stop killed the `npx` wrapper, not the real server holding the
  port. → record the real PID, spawn error handlers.
- **Transient Firecrawl `fetch failed`** killed a run outright (2026-09-16). → one retry
  with backoff.
- **Undiagnosable failures:** job state was memory-only. → per-run `sites/<domain>/run.log`.

**Decision reversal — unattended runs are dead.** They burn money on the wrong pages and
can't be stopped. The review gate (approve page selection before the expensive rebuild),
the stop button, and the pre-QA cost checkpoint exist on purpose. Do not "streamline"
them away.

## The big token decisions

- **Screenshot tiling at capture** (~25–40% of a run's tokens saved). Firecrawl's
  full-page PNG (1920×6863 typical) is unreadable when downscaled, so the agent used to
  invent an ffmpeg cropper *every run* and re-read 5–6 crops per page. Now `pipeline.ts`
  slices tiles once with `sharp` at capture time, and both prompts explicitly forbid the
  agent from cropping anything. `sharp` is the one dependency exception ever granted —
  Node stdlib can't decode a PNG.
- **Scaffold in code, not prose.** `package.json`/`next.config.ts`/etc. used to be
  spelled out in the orchestrator prompt and retyped by Opus every run. They're written
  from `pipeline.ts` before the session starts.
- **QA subagent runs on Sonnet** with no screenshot re-read — the `next build` + grep
  checks are what actually catch things. (A scored visual-diff loop is a v2 seed; it only
  makes sense now that tiling made images cheap.)

## Hosted mode (live)

The tool runs permanently on the droplet behind nginx with basic-auth — currently live at
`hello-dolly-gyds101.ianray.com`. `HOSTED=1` flips the mode; local Mac behaviour is
byte-for-byte unchanged. In hosted mode nginx serves `sites/<domain>/app/out/` at
`/preview/<domain>/` — no per-preview process, port, or pid file.

**The subpath problem** (why `basePath` and not something simpler): a Next static export
addresses everything from the site root, so mounting it at `/preview/<domain>/` breaks
every asset. Three options were weighed:

1. *nginx rewrites the subpath back* — impossible: `/_next/static/chunks/main.js` carries
   no hint of which clone it belongs to.
2. *Subdomain per clone* — cleanest, rejected on ops cost: wildcard DNS + DNS-01 wildcard
   cert + a domain-slugging scheme, too much standing infrastructure for one operator.
3. *Bake the prefix in at generation time* — **chosen**: `basePath: '/preview/<domain>'`
   in the generated `next.config.ts`, plus a deterministic `rebaseExport` post-pass for
   raw `public/` references Next doesn't touch. HTML/CSS only, never `.js`.

**Auth lives in nginx, not `server.ts`** — a second auth layer in the app is a second
thing to get wrong. The ops half (nginx/systemd/certbot/ufw) is `docs/HOSTED.md`, applied
by hand by Ian, never checked into the repo or run by an agent. Clones built before
hosted mode have no `basePath` and render unstyled under `/preview/` until rebuilt — an
operator step, not a bug.

## v2 seeds (the roadmap, in rough priority order)

- **Migration parity report** (flagship): URL inventory (crawl + their sitemap) with each
  URL's route in the clone, image manifest with alt text, per-page content inventory
  (word counts, headings, phone/address/email verified present), SEO parity table
  (title/description/OG/canonical/JSON-LD ✓/✗), redirect map → `_redirects`. Mostly a
  rendering pass over `pages.json` + site-analysis.json.
- **site-analysis.json contract**: one analyzer pass writes
  `{ designTokens, sharedChrome, pageMap, sectionInventory }` before builders fan out.
  Prereq for the parity report, redesign mode, and form detection.
- **Scored visual-diff fix loop**: screenshot clone at source viewports, score 0–100
  (layout 25 / colors 20 / type 15 / spacing 15 / content 15 / responsive 10), fix the
  top diff, re-score, max 3 iterations.
- **Mobile source screenshots** (390px per page) fed to builders.
- **SEO/meta parity**: carry title/description/OG/canonical/JSON-LD, generate
  sitemap.xml + robots.txt, preserve URL paths exactly, 301 anything that moves.
- **Asset localization**: download hot-linked images into `public/`, rewrite srcs.
- **Chat-based editing** of a finished clone (`query()` with `resume`, per-clone git repo
  for free undo) — the actual product long-term.
- **Multi-job queue + persistence** (SQLite) instead of one in-memory job.
- **Richer selection UI**, **public publishing** (Cloudflare Pages), **working forms**
  (relay), **redesign mode** (swap designTokens, 2–3 variants).

## Explicitly not doing

- DOM-heuristic component/API detection — Firecrawl markdown + screenshots cover it.
- Multi-framework output — Next.js/Tailwind only.
- CMS/WordPress content sync — only if a client demands it.

## Known limits

- Bot-protected sites need Firecrawl stealth mode (5 credits/page).
- Iframes, forms, and backend features don't transfer — front-end only; say so to clients.
