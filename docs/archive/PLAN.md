# Website Clone PoC — Phased Plan

Goal: web page with one input ("enter URL to clone") → pipeline clones the site into an
AI-maintainable Next.js/Tailwind codebase → progress shows as a human-readable step list.

## Stack (decided)

| Layer | Choice | Why |
|---|---|---|
| Pipeline brain | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, TypeScript) | `query()` streams every tool-use event — each one maps to a log line for free |
| Extraction | Firecrawl API (free tier: 1,000 one-time credits ≈ 1,000 pages) | site → markdown + page map + image URLs, no scraper code to write |
| Rebuild target | Next.js + Tailwind, static export | agent-friendly, deployable anywhere |
| Progress → browser | SSE (one `EventSource`) | one-way push, auto-reconnect, no websocket plumbing |
| Deploy of clones | Local: static export served on a localhost port | zero accounts/keys; Cloudflare Pages deferred until a clone must be public |
| Where pipeline runs | Local machine for PoC (Docker on Railway/Fly later) | Vercel functions can't hold Chromium/long jobs; local is zero setup |

## Human gates (pipeline pauses and asks — never stubs)

1. **Before Phase 0:** Firecrawl API key (free signup) + the test site URL to clone.
2. **After Phase 0:** quality gate — human eyeballs spike clone vs original and
   approves before Phase 1 is built. This is the only go/no-go decision.
3. **Before any future public deploy** (deferred): Cloudflare credentials.

## Phase 0 — Spike: prove clone quality (no UI)

The only real risk is "is the clone good enough?" — test that before building anything.

- One script: `spike.ts` — takes a URL, calls Firecrawl `/crawl`, dumps markdown +
  screenshots into `sites/<domain>/source/`, then runs one Agent SDK `query()` with a
  clone prompt (crib the interaction-sweep + QA checklist from
  JCodesMore/ai-website-cloner-template's skill file) to generate `sites/<domain>/app/`.
- Run against ONE small real client site. Eyeball result vs original.
- Exit criteria: clone is presentable enough that you'd show a client. If not, iterate
  on the prompt here — cheapest place to fix quality.

## Phase 1 — Pipeline as a proper module

- Extract the spike into `pipeline.ts`: `runClone(url, onLog)` — same logic, but every
  step and every SDK `tool_use` event calls `onLog(humanReadableLine)`.
- Canonical step names (these become the UI progress list):
  1. Mapping pages (Firecrawl `/map`)
  2. Extracting content — text, images (Firecrawl `/crawl`)
  3. Capturing design (screenshots per breakpoint)
  4. Rebuilding site (Agent SDK session)
  5. Verifying against original (agent visual QA pass)
  6. Publishing local preview
- Log line mapping: `tool_use: Write app/page.tsx` → "Creating homepage…". A tiny
  lookup table, not NLP.
- Exit criteria: `npx tsx pipeline.ts <url>` prints the readable log and produces a
  working `next build`-able app.

## Phase 2 — Thin web UI

- One Next.js app (or single Express file — whichever is fewer lines): 
  - `GET /` — input box + progress list (single page, plain React state).
  - `POST /api/clone` — starts `runClone`, returns job id.
  - `GET /api/clone/:id/events` — SSE stream of `onLog` lines; UI appends to list,
    checkmarks the 6 canonical steps as they pass.
- One job at a time, in-memory job state. No DB, no queue, no auth.
- Exit criteria: paste URL in browser, watch the 6 steps complete.

## Phase 3 — Serve the clone locally

- End of pipeline: `next build` (static export), then serve `out/` on a free local
  port → log `http://localhost:<port>` as the final step, show it as a link in the UI.
- Everything runs on the Mac: the tool and every cloned preview.
- Exit criteria: URL in → clickable local clone URL out, start to finish from the browser.
- Later (deferred): swap the serve step for `wrangler pages deploy out/` when a
  clone needs to be client-visible.

## Parallelism & model assignment

**Build-time (developing the PoC).** Phases 0→1→3 are sequential (each consumes the
last). Phase 2 (UI) is the exception: it only depends on the contract
(`runClone(url, onLog)` + the 6 step names), so it can be built in parallel with
Phase 0/1 by a separate subagent.

- Phase 0/1 pipeline + clone prompt: **Opus** (judgment-heavy: prompt quality decides clone quality)
- Phase 2 UI: **Sonnet**, in parallel (boilerplate React/SSE against a fixed contract)
- Phase 3 serve wiring: **Sonnet** (mechanical: build + local serve + log line)
- Review/integration: main thread

**Runtime (inside each clone job).** The rebuild step (step 4) fans out per page:
orchestrator maps pages, then one builder subagent per page in parallel, then a QA pass.

- Orchestrator + visual QA/verify: **Opus** (layout judgment, diffing against original)
- Per-page builders: **Sonnet** (each gets one page's markdown + screenshot + shared
  layout/tokens; cheap and parallel)
- Extraction/deploy steps: no model — plain code (Firecrawl API, wrangler)

The Agent SDK supports this directly (subagent definitions with per-agent `model`).
PoC simplification: single-agent rebuild is acceptable for Phase 0's quality spike;
add the per-page fan-out in Phase 1 where it also speeds up multi-page sites.

## Deferred (not PoC)

- Multiple concurrent jobs / queue / persistence — in-memory is fine for a demo
- Auth on the tool
- WordPress REST / CMS content extraction — Firecrawl markdown covers the PoC
- Per-client git repos + agent maintenance loop — that's the product, after PoC
- Self-hosted Firecrawl (AGPL, docker compose) — only if API credits become a cost issue

## Known risks

- Bot-protected sites (Wix sometimes) — Firecrawl stealth mode costs 5 credits/page;
  pick a friendly site for the demo.
- Iframes/forms/backend features don't transfer — front-end only; say so in the demo.
- Firecrawl free tier is one-time 1,000 credits — enough for the PoC, budget $16/mo after.
