# Phase 4.1 — Hosted mode (the code half)

**Why:** the tool now lives on the droplet permanently, behind nginx, on Ian's domain. He
should open the URL, run a clone, and click through to the finished site — without ever
pulling `sites/` down to his Mac. Today the last step of a run spawns a detached
`npx serve` on a random port (`serve.ts:138-188`), which is exactly wrong on a VPS: the
port is firewalled, the process is unsupervised, and the preview dies with the next reboot.

On the VPS, **nginx** serves each `sites/<domain>/app/out/` statically at
`/preview/<domain>/`. No per-preview process, no per-preview port, nothing to stop.

This phase is the code switch only. The nginx/ufw/systemd half is a manual runbook —
`docs/HOSTED.md` — that Ian applies on the droplet by hand. Do not try to execute it, do
not write nginx configs into the repo, do not add a provisioning script.

**Hosted mode is a mode, not a replacement.** On the Mac, `HOSTED` is unset and every
behaviour below stays byte-for-byte what it is today: `next build`, `npx serve out`,
`serve.pid`, `http://localhost:<port>`. Every hosted branch is an `if` around the existing
code, never a rewrite of it.

## The switch

`HOSTED=1` in the environment (set by the systemd unit's `EnvironmentFile`, see
`docs/HOSTED.md`). Read it once, in one place, and export the predicate so both `serve.ts`
and `pipeline.ts` agree:

```ts
export const hosted = () => !!process.env.HOSTED;   // in serve.ts
```

A function, not a module-level `const` — the phase's own tests need to flip the variable
between calls without re-importing the module.

## (a) The subpath problem — decide this first, it drives everything else

A Next.js static export addresses **everything** from the site root: `/_next/static/...`
for chunks, CSS and `next/font` files, and `/logo.png` for anything the page-builders
downloaded into `app/public/` (the orchestrator prompt mandates exactly that shape —
`pipeline.ts:326-328` and `:386-390`, plain `<img src="/name.ext">`, no `next/image`).
Mount that export at `/preview/foo.com/` and every one of those URLs resolves against the
server root instead, so the page loads unstyled with broken images. This is not a
speculative risk — it is what will happen on the first hosted run.

Three ways out were considered:

1. **nginx rewrites the subpath back.** Impossible for root-absolute URLs: a request for
   `/_next/static/chunks/main.js` carries no hint of which clone it belongs to. Recovering
   it from `Referer` is guesswork and fails for `<link rel=preload>` and CSS-loaded fonts.
   Rejected.
2. **A subdomain per clone** (`foo-com.clones.<host>`), so each export gets its own origin
   and root-absolute URLs are simply correct. Genuinely the cleanest, and rejected on ops
   cost: it needs wildcard DNS, a DNS-01 wildcard certificate, and — because the clone
   *is* a domain name — a slugging scheme (`ianray.com` → `ianray-com`) so the host stays
   one label deep under the wildcard. Too much standing infrastructure for one operator.
3. **Bake the prefix in at generation time.** Chosen. In hosted mode the generated app is
   built with `basePath: '/preview/<domain>'`, which makes Next emit every one of *its*
   URLs — chunks, CSS, `next/font` files, `<Link>` hrefs, the client runtime's chunk
   loader — under that prefix. The one class Next does **not** touch is raw
   `public/` references written by the page-builders (`<img src="/logo.png">`, plain
   `<a href="/about">`, CSS `url(/hero.jpg)`), so a small deterministic post-export pass
   fixes those. Both halves are in code; neither depends on a subagent remembering a rule.

The build happens where it is served — a hosted run builds on the droplet and is served by
that droplet's nginx — so baking the prefix in is not a lock-in. The Mac never serves a
VPS-built export.

### `basePath`

- `basePath` must start with `/` and must **not** end with one: `/preview/ianray.com`.
- Set **only** `basePath`. `assetPrefix` defaults to it, so setting both is redundant. If
  the smoke check in `docs/HOSTED.md` shows `_next` URLs arriving unprefixed, adding a
  matching `assetPrefix` is the documented fix — do not pre-emptively add it.
- `basePath` changes URLs, not the export's directory layout: `out/index.html`,
  `out/about.html` and `out/about/index.html` stay exactly where they are. So
  `missingExportRoutes` (`pipeline.ts:563-575`) needs **no** change. Confirm this by
  reading the config docs rather than by running a build, and say so in the commit message.

Where to write it depends on what Phase 3.2 landed:

- **If `scaffold()` exists** (Phase 3.2 writes `app/next.config.ts` from code): give it the
  base path and have it emit
  `export default { output: 'export', images: { unoptimized: true }, basePath: '/preview/<domain>' }`
  in hosted mode, and today's object with no `basePath` otherwise. 3.2 already overwrites
  `next.config.ts` unconditionally, so a re-run self-heals.
- **If it does not**, write/patch `app/next.config.ts` from `rebuild()`
  (`pipeline.ts:460-468`) before the `query()` session starts, in hosted mode only.
- Either way the domain comes from the site directory: `path.basename(siteDir)` is exactly
  the domain (`pipeline.ts:624-625`). Do not re-derive it from the target URL in two places.
- In hosted mode the orchestrator prompt must gain one clause: `next.config.ts` already
  exists and **`basePath` must not be removed or edited**. One sentence, appended only when
  hosted — the local prompt is unchanged.

### The post-export rebase pass

New exported function in `serve.ts`, pure and directly testable:

```ts
export function rebaseExport(outDir: string, basePath: string): number   // files changed
```

- Walks `outDir` recursively; touches `.html` and `.css` only. Never `.js` — Next's own
  runtime already carries the prefix from `basePath`, and string-editing bundles is how you
  get a site that half-works.
- Rewrites root-absolute references in `src=`, `href=`, `srcset=` (each candidate in the
  comma list) and CSS `url(...)`.
- Skips a value that: already starts with `basePath`; starts with `//`; has a scheme
  (`http:`, `https:`, `data:`, `mailto:`, `tel:`); or starts with `#` or `?`. Only a value
  whose first character is `/` and whose second is not `/` is a candidate.
- Therefore **idempotent** — `_next` URLs are already prefixed and get skipped, and running
  it twice changes nothing. Make that a test.
- Call it from `publishPreview` in hosted mode, after every successful build — including
  the re-export retry path (`serve.ts:114-117`), because `next build` rewrites `out/`.
  Log one line: `Publishing local preview — rebased N file(s) to /preview/<domain>/`.
- Regex-and-`node:fs` only. No parser, no dependency.

## (b) `serve.ts` — skip the spawn in hosted mode

`publishPreview` (`serve.ts:93-189`) keeps its signature. The hosted branch goes **after**
the build and the export-completeness block and **before** the stale-pid cleanup at
`serve.ts:125`:

- Everything up to and including `verifyExport` (`serve.ts:101-121`) runs unchanged — the
  export is the deliverable, and the missing-route retry is exactly as valuable hosted.
- Then, if hosted: run `rebaseExport`, log
  `Publishing local preview — hosted mode, served by nginx at /preview/<domain>/`, and
  `return` that path. **Skip** the stale-pid kill (`:125-136`), `freePort`
  (`:138`), the `npx serve` spawn (`:139-159`), the pid-file write (`:183`) and
  `waitFor200` (`:186`). Nothing writes `serve.pid` in hosted mode, so nothing is left to
  reap on reboot.
- The domain comes from `appDir`, not a new parameter: `appDir` is always
  `sites/<domain>/app`, so `path.basename(path.dirname(appDir))` is the domain. Put that in
  a tiny exported helper (`previewPathFor(appDir): string` → `/preview/<domain>/`) so the
  phase can test the mapping under `/tmp` without building anything.
- The `signal?.aborted` guard at `serve.ts:123` stays and still applies — a stopped job
  must not get a preview link.

`listPreviews` / `stopPreview` (added by Phase 3.3): in hosted mode there are no pid files,
so the list would be empty forever and Ian would have no way to reach an older clone. Give
`listPreviews` a hosted branch that scans `sites/*/app/out/index.html` instead and returns
`{ domain, pgid: 0, port: null, url: '/preview/<domain>/', alive: true }` per built export.
`stopPreview` in hosted mode returns `false` — there is no process to stop — and the UI must
not render a Stop button for those rows. If Phase 3.3 landed without `listPreviews`, do the
same scan inline in the `/api/previews` handler and note the divergence in the commit
message; do not re-do 3.3's work.

## (c) `pipeline.ts` — the link

- `runClone`'s publish block (`pipeline.ts:684-693`) is unchanged in shape. `publishPreview`
  now returns either `http://localhost:4321` (local) or `/preview/<domain>/` (hosted), and
  the existing `Publishing local preview → ${previewUrl}` line at `:693` carries it either
  way. Do not add a second log line, and do not branch on the mode here — the whole point of
  returning a string is that the caller does not care.
- Keep the `Publishing local preview` prefix on every line this touches (see the contract
  below).

## (d) `server.ts` — make the link clickable, and behave behind a proxy

- `linkify` (`server.ts:342-344`) only matches `https?://`, so a hosted preview path renders
  as inert text. Widen it to also match a leading `/preview/…` path. Keep it one regex and
  keep using `innerHTML` on the same element (`server.ts:362-364`) — no new rendering path.
- SSE: add `'X-Accel-Buffering': 'no'` to the event-stream headers
  (`server.ts:495-499`). nginx also gets `proxy_buffering off` in the runbook; the header is
  the belt to that braces, and it costs one line. Nothing else about the SSE response
  changes — the replay loop (`:500-517`) and the subscriber list are untouched.
- Bind: `server.listen(PORT)` (`server.ts:664-666`) listens on every interface. In hosted
  mode listen on `127.0.0.1` only, so the box is not one `ufw` mistake away from an open
  clone tool. Local mode keeps today's behaviour — `listen(PORT)` with no host — because the
  gate and Ian's browser both reach it either way. Keep the startup `console.log` accurate
  for both.
- Do **not** add auth, sessions, or a login page. Authentication is nginx basic-auth, in the
  runbook. A second auth layer here is a second thing to get wrong.

## SSE prefix contract

`STEPS` (`server.ts:5-12`) and the matcher at `server.ts:366` are unchanged by this phase.
Every line this phase adds belongs to step 6 and must start with the exact string
`Publishing local preview` — a line like `Hosted mode — serving via nginx` silently resets
the UI's progress. Do not rename, reorder or add to `STEPS`, and keep `QA_MARKER`
(`pipeline.ts:308`) working.

The previews list stays a plain REST endpoint (Phase 3.3's rule): no new SSE event, nothing
pushed through `jobLog`, nothing written into `job.lines`.

## Acceptance criteria

- With `HOSTED` unset, every code path is the one that exists today: `next build`, stale-pid
  kill, `npx serve out`, `serve.pid` written, `http://localhost:<port>` returned. Diff the
  local path and confirm it is only wrapped, not edited.
- `rebaseExport` against a fixture directory under `/tmp` containing one HTML file
  (`src="/logo.png"`, `href="/about"`, `href="/preview/foo.com/_next/x.css"`,
  `src="https://cdn/x.png"`, `href="#top"`, `href="mailto:a@b.c"`, `srcset="/a.png 1x, /b.png 2x"`)
  and one CSS file (`url(/hero.jpg)`, `url(data:image/png;base64,…)`) rewrites exactly the
  root-absolute local ones, leaves the rest byte-identical, and changes nothing on a second
  run.
- `previewPathFor('/x/sites/foo.com/app')` is `/preview/foo.com/`.
- With `HOSTED=1`, `listPreviews()` against a fake tree under `/tmp` containing
  `sites/foo.com/app/out/index.html` returns one row with `url: '/preview/foo.com/'`, and
  writes no pid file.
- The generated `next.config.ts` carries `basePath: '/preview/<domain>'` in hosted mode and
  no `basePath` key at all otherwise, and keeps `output: 'export'` in both.
- `linkify('Publishing local preview → /preview/foo.com/')` produces an anchor.
- `npx tsc --noEmit` exits 0 and `bash scripts/gate.sh` passes (the gate runs with `HOSTED`
  unset — if it does not, the bind change will make it hang, so do not set `HOSTED` in the
  gate).

## Do not

- **No new dependencies.** `node:fs`, `node:path`, `node:child_process` and a regex cover
  all of it. No express, no http-proxy, no html parser, no cheerio. Do not edit
  `package.json`.
- **Do not break local mode.** Every change is an `if` around existing code. If a hosted
  branch forces you to restructure the local path, you have picked the wrong seam.
- Do not change the six step names or break the step-name prefix convention.
- Do not make `pipeline.ts` import from `server.ts`. `serve.ts` may be imported by both.
- Do not rewrite `.js` files in `out/`, and do not extend `rebaseExport` to `.json`,
  `.xml` or `.txt`. HTML and CSS only.
- Do not kill a preview by bare pid anywhere you touch (`serve.ts:24-26` stays the only kill
  path), and do not remove the legacy bare-number pid-file tolerance Phase 3.3 added.
- Do not write nginx config, a systemd unit, a `.env.hosted`, or a deploy script into the
  repo. `docs/HOSTED.md` is the deliverable for that half and Ian applies it by hand.
- Do not add authentication, TLS handling, or `X-Forwarded-*` trust logic to `server.ts`.
- Do not start a real clone run, a preview server, `next build`, or nginx to test this.
  Every acceptance check above runs against fixtures in `/tmp`.
- Do not write into `sites/`. The four real clones there were built without a `basePath` and
  will render unstyled under `/preview/` until they are rebuilt — that is a documented
  operator step in `docs/HOSTED.md`, not something this phase fixes in place.
