# Phase 3.1 — Screenshot tiling at capture

**Why now:** Firecrawl gives us one full-page PNG per page — 1920×6863 is typical. Read
whole, it is downscaled until the body copy is unreadable, so the orchestrator writes
itself an ffmpeg/sips cropper *every run*, crops the PNG into 5–6 slices, and then reads
each slice. We pay for inventing the cropper, for the shell round-trips, and for the
re-reads. Measured across the three post-mortem runs that is ~25–40% of a run's tokens.

Slice the PNG once, in plain code, at capture time. The agent gets a list of readable
tiles and never touches an image tool again.

## Goal

1. After capture, every page with a desktop screenshot also has viewport-height tiles on
   disk at `sites/<domain>/source/tiles/<name>-1.png`, `-2.png`, … (1-indexed, top to
   bottom).
2. The orchestrator prompt and `pageBuilderPrompt` tell the agent to read those tiles, in
   order, and explicitly forbid building a cropper.
3. Tiling is best-effort: a page whose tiling fails still lists its full PNG and the run
   continues.

## The one permitted new dependency

`package.json` (`package.json:14-17`) has no image capability — the deps are
`@anthropic-ai/claude-agent-sdk` and `tsx`, and Node's stdlib cannot decode a PNG. So:

**This phase, and only this phase, is allowed to add `sharp` to `dependencies` and run
`npm install sharp` in the repo root.** That overrides the blanket "No new dependencies /
Do not edit `package.json`" rule in `CLAUDE.md:34-37` for this one package. Add nothing
else — no `jimp`, no `pngjs`, no `@types/*` (sharp ships its own types), no image CLI
wrapper. Do not shell out to `ffmpeg`, `convert`/`magick` or `sips`: those are the exact
system-dependent hack this phase exists to delete, and the tool has to behave identically
on the Mac and on the VPS.

If `sharp` cannot be installed in this environment, do **not** improvise a substitute:
land nothing, and say so in the phase report.

## Files / anchors to touch

### `pipeline.ts` — the tiling step

- Add a constant block near `MOBILE_SHOTS` (`pipeline.ts:18`), e.g.
  `TILE_HEIGHT = 1080` (the desktop viewport height Firecrawl shoots at),
  `TILE_OVERLAP = 120` (so a heading that lands on a boundary is whole in one tile), and
  `MAX_TILES = 12` (a hard cap; 6863px at 1080 is 7 tiles, so the cap only fires on
  pathological pages — when it does, keep the *top* N and log that the tail was skipped).
- New function `tileScreenshots(pages, sourceDir, onLog): Promise<{ page: Page; tiles: string[] }[]>`,
  modelled on `captureMobile` (`pipeline.ts:222-257`) — same shape, same caching
  behaviour, same "a failure degrades fidelity but must not kill the job" try/catch at
  `pipeline.ts:251-254`.
  - Source: `path.join(sourceDir, p.screenshot)` for every page where `p.screenshot` is
    non-null. Skip pages without one.
  - Output dir: `path.join(sourceDir, 'tiles')`, created with `mkdirSync(..., { recursive: true })`.
  - Returned tile paths must be **relative to the site dir**, i.e. `source/tiles/<name>-1.png`,
    because that is what goes into the prompt and the agent's cwd is `siteDir`
    (`pipeline.ts:498`). Note that `pages.json` stores `screenshot` relative to `source/`
    instead — do not "fix" that inconsistency here, just be deliberate about which form
    you emit.
  - Idempotent: if `<name>-1.png` already exists and its mtime is newer than the source
    PNG's, reuse the existing tiles (glob the directory for `<name>-*.png`, sort
    numerically — **not** lexically, or tile 10 sorts before tile 2) and log
    `Capturing design — tiles for <name> cached`.
  - A page shorter than `TILE_HEIGHT` gets exactly one tile (which is a copy of the full
    PNG — write it anyway so the prompt has one uniform rule).
  - Every log line keeps the `Capturing design` prefix (see the contract below).
- Call it from `runClone` right after `captureMobile` (`pipeline.ts:645`) and **before**
  the `CLONE_DRY_RUN` return at `pipeline.ts:648-651`, so `CLONE_DRY_RUN=1` exercises the
  tiler for free.
- Thread the result through to `rebuild` (`pipeline.ts:460-467`) and into
  `orchestratorPrompt` (`pipeline.ts:354`) alongside `mobile`. Follow the existing
  `{ page, file }[]` + `mobileFor` lookup pattern at `pipeline.ts:355`.
- **Do not** add `tiles` to the `Page` type (`pipeline.ts:14`) or to the `PagesCache`
  written at `pipeline.ts:215-216`. Tiles are derived from a PNG on disk, not from the
  scrape, and putting them in the cache would change `crawlCacheKey`
  (`pipeline.ts:133-142`) and force a paid re-scrape of every cached site. Recomputing (or
  reusing) tiles on every run is free.

### `pipeline.ts` — the prompts

- `orchestratorPrompt`, the `source/` inventory at `pipeline.ts:358-363`: keep the
  `source/<name>.png` bullet but demote it, and add a `source/tiles/<name>-N.png` bullet
  describing them as *pre-cropped, full-resolution, viewport-height slices, already made
  for you, top to bottom*.
- The page list at `pipeline.ts:365-373`: for each page, append its tile paths (or a tile
  count plus the `source/tiles/<name>-` prefix and the range — whichever keeps the prompt
  shorter for 30 pages; a count plus prefix is almost certainly shorter and is fine, as
  long as the naming rule is stated exactly once and is unambiguous).
- Phase 4 delegation contract at `pipeline.ts:432-441`: the bullet listing "the source
  file names" must now require the tile paths to be passed to each page-builder, the same
  way `source/design-tokens.md` is passed as a path.
- `pageBuilderPrompt` (`pipeline.ts:310-334`): the input list at `:312-314` and the
  screenshot rule at `:317-319` change from "Read the PNG with the Read tool and look at
  it" to "read the tiles in order with the Read tool — they are the page top to bottom at
  full resolution". Keep everything else in that rule verbatim: the screenshot is still
  the spec, the markdown is still the content, and the "if the original has 12
  testimonials, build 12" line stays.
- Add one explicit prohibition to **both** prompts: *the tiles already exist; do not crop,
  resize, convert or otherwise process any image; do not write a cropping script; do not
  install or invoke ffmpeg, ImageMagick, sips or any image tool.* This sentence is the
  whole point of the phase — without it the orchestrator will keep building its cropper
  out of habit.
- `qaPrompt` (`pipeline.ts:336-352`) is unchanged — Phase 1.5 already removed its
  screenshot reads and they stay removed.

### `pipeline.ts` — the log-line mapper

- `describeTool` (`pipeline.ts:285-288`) turns a `Read` of a `*.png` into
  `Studying design: <basename>…`. With tiles that becomes `Studying design: home-1…`,
  `home-2…`, … — seven UI lines per page. Strip a trailing `-<digits>` from the basename
  so every tile of one page produces the identical line, which the repeat-collapsing
  `log()` at `pipeline.ts:473-477` then folds into one. Cheap, and it keeps the UI
  readable.

## SSE prefix contract

`STEPS` (`server.ts:5-12`) and the matcher at `server.ts:366`
(`STEPS.findIndex(s => line.startsWith(s))`) are unchanged by this phase. Tiling happens
inside step 3, so **every** line it emits must begin with the exact string
`Capturing design` — `Capturing design — tiled home into 7 slices` is correct, `Tiling
home…` silently resets the UI's active step. Do not rename, reorder or add to `STEPS`.

## Acceptance criteria

- `sharp` is the only added dependency; `package.json` gains exactly one line under
  `dependencies`.
- Tiling a real full-page PNG produces N tiles of `TILE_HEIGHT` (the last one shorter),
  named `<name>-1.png` … `<name>-N.png`, that together cover the full image. To test:
  **copy** a PNG out of `sites/` into `/tmp` and run the tiler against that — never write
  into `sites/` by hand.
- A second call reuses the cached tiles and emits the `cached` line instead of re-slicing.
- A corrupt or missing source PNG logs a `Capturing design — …` failure line and does not
  throw.
- No prompt in `pipeline.ts` mentions ffmpeg/sips/ImageMagick, and both prompts carry the
  explicit "do not crop anything yourself" rule.
- Every tiling log line starts with `Capturing design`.
- `npx tsc --noEmit` exits 0 and `bash scripts/gate.sh` passes.

## Do not

- No new dependencies **other than `sharp`**. Not `jimp`, not `pngjs`, not `canvas`, not a
  CLI wrapper. One package, in `dependencies`, nothing else touched in `package.json`.
- Do not shell out to ffmpeg / ImageMagick / sips from `pipeline.ts`.
- Do not change the six step names or break the step-name prefix convention.
- Do not add tiles to `Page`, to `pages.json`, or to `crawlCacheKey` — that would invalidate
  every cached crawl and cost real Firecrawl credits.
- Do not tile the `.mobile.png` shots. A 390px-wide screenshot is already readable whole;
  mobile tiling is deliberately out of scope.
- Do not weaken "the screenshots are the spec / the markdown is the content / no
  hot-linking" (`pipeline.ts:379-390`). This phase changes *how the image is read*, not
  what is required of the clone.
- Do not write into `sites/`. Copy a PNG out to `/tmp` if you need a real input to test
  against.
- Do not start a real clone run, a preview server, or `next build`. `CLONE_DRY_RUN=1`
  exercises capture without spending agent tokens.
