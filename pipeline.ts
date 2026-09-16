// Phase 1 pipeline: URL -> Firecrawl map/crawl/screenshots -> Agent SDK rebuild -> local preview.
// Every one of the 6 canonical steps emits an onLog line starting with its exact step name.
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { hosted } from './serve.js';

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional when FIRECRAWL_API_KEY is already in the environment.
}

type Page = { url: string; title: string; md: string; screenshot: string | null };

const FIRECRAWL = 'https://api.firecrawl.dev/v2';
const MAX_PAGES = 30;
const MOBILE_SHOTS = 3;
// Full-page screenshots are ~1920x7000; read whole they are downscaled until the copy is
// unreadable. Slice them into viewport-height tiles at capture time so the agent never has to
// build itself a cropper. The overlap keeps a heading that lands on a boundary whole in one tile.
const TILE_HEIGHT = 1080;
const TILE_OVERLAP = 120;
const MAX_TILES = 12;

const slug = (url: string) => {
  const p = new URL(url).pathname.replace(/^\/|\/$/g, '');
  return p ? p.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() : 'home';
};

function headers() {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('FIRECRAWL_API_KEY is not set (put it in .env at the project root).');
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

/**
 * One retry, after ~2s, for a Firecrawl HTTP call. Retries when the `fetch` promise *rejects*
 * (no response at all — DNS, reset, "fetch failed") or the response is 429/5xx. Never retries
 * any other 4xx: a bad key or a bad URL fails identically the second time, and the error
 * message from the first attempt is what the operator needs to fix it.
 *
 * `/batch/scrape` is a POST and therefore not strictly idempotent — retrying it could start a
 * duplicate Firecrawl job. Accepted: when the fetch rejected, no job handle ever came back, so
 * there is nothing to poll and nothing to salvage from the first attempt anyway; a duplicate job
 * costs credits, a dead run costs the whole crawl.
 */
async function fetchRetry(url: string, init: RequestInit, label: string, onLog: (l: string) => void): Promise<Response> {
  try {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status < 500) return res;
    onLog(`${label} failed (${res.status}), retrying in 2s…`);
  } catch (err) {
    onLog(`${label} failed (${err instanceof Error ? err.message : err}), retrying in 2s…`);
  }
  await new Promise((r) => setTimeout(r, 2000));
  return fetch(url, init);
}

async function firecrawl(endpoint: string, body: unknown, onLog: (l: string) => void, stepPrefix: string): Promise<any> {
  const res = await fetchRetry(
    `${FIRECRAWL}${endpoint}`,
    { method: 'POST', headers: headers(), body: JSON.stringify(body) },
    `${stepPrefix} — Firecrawl ${endpoint}`,
    onLog,
  );
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    throw new Error(`Firecrawl ${endpoint} failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

/** Download a Firecrawl screenshot (URL or data: URI) to disk. */
async function saveImage(src: string, file: string, onLog: (l: string) => void, stepPrefix: string) {
  let buf: Buffer;
  if (src.startsWith('data:')) {
    buf = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
  } else {
    const res = await fetchRetry(src, {}, `${stepPrefix} — screenshot download`, onLog);
    buf = Buffer.from(await res.arrayBuffer());
  }
  fs.writeFileSync(file, buf);
  return buf.length;
}

// ---------------------------------------------------------------- step 1: map

async function mapPages(target: string, onLog: (l: string) => void): Promise<string[]> {
  const json = await firecrawl('/map', { url: target, limit: 100 }, onLog, 'Mapping pages');
  const links: string[] = (json.links ?? []).map((l: any) => (typeof l === 'string' ? l : l.url)).filter(Boolean);
  onLog(`Mapping pages… found ${links.length}`);
  return links;
}

export type FilteredLink = { url: string; reason: string };
export type PagePick = { picked: string[]; filtered: FilteredLink[] };

/**
 * Pick the MAX_PAGES most representative URLs from the site map: shallow nav
 * pages (About, Services, Contact…) before deep ones, dated posts last — so a
 * capped clone gets the site's structure, not 13 news articles. Also reports
 * what got dropped and why, for the pre-rebuild review gate.
 */
export function pickPagesDetailed(target: string, links: string[]): PagePick {
  const host = new URL(target).hostname.replace(/^www\./, '');
  const seen = new Set<string>();
  const candidates: { url: string; score: number; dated: boolean }[] = [];
  const filtered: FilteredLink[] = [];
  for (const link of links) {
    let u: URL;
    try {
      u = new URL(link);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, '') !== host) {
      filtered.push({ url: link, reason: 'off-host' });
      continue;
    }
    const p = u.pathname.replace(/\/$/, '');
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|xml|txt)$/i.test(p)) {
      filtered.push({ url: link, reason: 'asset file, not a page' });
      continue;
    }
    if (/\/(feed|wp-json)\b/.test(p)) {
      filtered.push({ url: link, reason: 'feed/wp-json endpoint' });
      continue;
    }
    const key = `${host}${p}`;
    if (seen.has(key)) {
      filtered.push({ url: link, reason: 'duplicate URL' });
      continue;
    }
    seen.add(key);
    const depth = p.split('/').filter(Boolean).length;
    const dated = /\/20\d\d(\/|$)/.test(p);
    // ponytail: naive heuristic — depth + dated-post penalty; refine if a site's nav still gets crowded out
    const score = depth + (dated ? 100 : 0);
    candidates.push({ url: `${u.origin}${p || '/'}`, score, dated });
  }
  candidates.sort((a, b) => a.score - b.score);
  const picked = candidates.slice(0, MAX_PAGES).map((c) => c.url);
  for (const c of candidates.slice(MAX_PAGES)) {
    filtered.push({
      url: c.url,
      reason: c.dated ? 'dated post, deprioritized past the MAX_PAGES cap' : 'over the MAX_PAGES cap',
    });
  }
  if (!picked.length) picked.push(target);
  return { picked, filtered };
}

/** Back-compat wrapper: just the picked URLs, no filter reasons. */
export function pickPages(target: string, links: string[]): string[] {
  return pickPagesDetailed(target, links).picked;
}

// ------------------------------------------------------ step 2: crawl content

type PagesCache = { key: string; crawledAt: string; pages: Page[] };

const BASE_SCRAPE_OPTIONS = {
  formats: ['markdown', { type: 'screenshot', fullPage: true }] as const,
};

function crawlCacheKey(urls: string[]): string {
  const canonical = JSON.stringify({
    urls: [...urls].sort(),
    maxPages: MAX_PAGES,
    ...BASE_SCRAPE_OPTIONS,
    // home gets onlyMainContent: false, every other page true — see crawlPages.
    onlyMainContent: 'split-by-home',
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

/** Kick off a Firecrawl batch/scrape job and poll it to completion. */
async function pollBatchJob(jobUrl: string, label: string, onLog: (l: string) => void): Promise<any[]> {
  let job: any;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetchRetry(jobUrl, { headers: headers() }, `Extracting content — Firecrawl poll (${label})`, onLog);
    job = await res.json();
    onLog(`Extracting content — ${label} ${job.completed ?? 0}/${job.total ?? '?'} pages`);
    if (job.status !== 'scraping') break;
  }
  if (job.status !== 'completed') {
    throw new Error(`Firecrawl crawl did not complete (status: ${job.status}).`);
  }
  return job.data as any[];
}

async function crawlPages(
  urls: string[],
  sourceDir: string,
  onLog: (l: string) => void,
): Promise<Page[]> {
  const indexFile = path.join(sourceDir, 'pages.json');
  const key = crawlCacheKey(urls);
  const forceRecrawl = !!process.env.CLONE_FORCE_RECRAWL;

  if (forceRecrawl) {
    onLog('Extracting content — forced recrawl (CLONE_FORCE_RECRAWL set)');
  } else if (fs.existsSync(indexFile)) {
    const stored = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    // A pre-existing bare-array pages.json (old format) is unkeyed by definition — treat as a miss.
    const cache: PagesCache | null = Array.isArray(stored) ? null : stored;
    if (cache?.key === key) {
      onLog(`Extracting content — reusing cached crawl (${cache.pages.length} pages, key ${key})`);
      return cache.pages;
    }
    onLog(`Extracting content — cache miss (page selection changed), recrawling ${urls.length} pages…`);
  }

  onLog(`Extracting content — scraping ${urls.length} selected pages…`);

  // The home page needs full chrome (nav + footer are extracted from it); inner pages don't.
  // Firecrawl's batch endpoint applies one options object to the whole batch, so split in two.
  const homeUrls = urls.filter((u) => slug(u) === 'home');
  const innerUrls = urls.filter((u) => slug(u) !== 'home');
  const jobs: Promise<any[]>[] = [];
  if (homeUrls.length) {
    const start = await firecrawl(
      '/batch/scrape',
      { urls: homeUrls, ...BASE_SCRAPE_OPTIONS, onlyMainContent: false },
      onLog,
      'Extracting content',
    );
    jobs.push(pollBatchJob(start.url, 'home', onLog));
  }
  if (innerUrls.length) {
    const start = await firecrawl(
      '/batch/scrape',
      { urls: innerUrls, ...BASE_SCRAPE_OPTIONS, onlyMainContent: true },
      onLog,
      'Extracting content',
    );
    jobs.push(pollBatchJob(start.url, 'inner', onLog));
  }
  const data = (await Promise.all(jobs)).flat();

  fs.mkdirSync(sourceDir, { recursive: true });
  const pages: Page[] = [];
  for (const d of data) {
    const url = d.metadata?.sourceURL ?? d.metadata?.url;
    if (!url) continue;
    let name = slug(url);
    while (pages.some((p) => p.md === `${name}.md`)) name += '-x';
    fs.writeFileSync(path.join(sourceDir, `${name}.md`), d.markdown ?? '');
    let shot: string | null = null;
    if (d.screenshot) {
      await saveImage(d.screenshot, path.join(sourceDir, `${name}.png`), onLog, 'Extracting content');
      shot = `${name}.png`;
    }
    pages.push({ url, title: d.metadata?.title ?? name, md: `${name}.md`, screenshot: shot });
    onLog(`Extracting content — saved ${name}`);
  }
  if (!pages.length) throw new Error('Firecrawl returned no pages for this site.');
  const cache: PagesCache = { key, crawledAt: new Date().toISOString(), pages };
  fs.writeFileSync(indexFile, JSON.stringify(cache, null, 2));
  return pages;
}

// -------------------------------------------- step 3: mobile design capture

async function captureMobile(
  pages: Page[],
  sourceDir: string,
  onLog: (l: string) => void,
): Promise<{ page: Page; file: string }[]> {
  const desktop = pages.filter((p) => p.screenshot).length;
  onLog(`Capturing design — ${desktop} desktop screenshots, adding mobile…`);

  const shots: { page: Page; file: string }[] = [];
  for (const p of pages.slice(0, MOBILE_SHOTS)) {
    const name = p.md.replace(/\.md$/, '');
    const file = `${name}.mobile.png`;
    const dest = path.join(sourceDir, file);
    if (fs.existsSync(dest)) {
      onLog(`Capturing design — mobile ${name} cached`);
      shots.push({ page: p, file });
      continue;
    }
    try {
      const json = await firecrawl(
        '/scrape',
        { url: p.url, mobile: true, formats: [{ type: 'screenshot', fullPage: true }] },
        onLog,
        'Capturing design',
      );
      const src = json.data?.screenshot;
      if (!src) throw new Error('no screenshot in response');
      await saveImage(src, dest, onLog, 'Capturing design');
      shots.push({ page: p, file });
      onLog(`Capturing design — mobile ${name}`);
    } catch (err) {
      // A missing mobile shot degrades fidelity but must not kill the job.
      onLog(`Capturing design — mobile ${name} failed (${err instanceof Error ? err.message : err})`);
    }
  }
  return shots;
}

// ------------------------------------------- step 3: screenshot tiling

/** This page's tile files, sorted numerically (tile 10 after tile 2, not before it). */
function existingTiles(tilesDir: string, name: string): string[] {
  return fs
    .readdirSync(tilesDir)
    .map((f) => ({ f, n: tileIndex(f, name) }))
    .filter((t) => t.n > 0)
    .sort((a, b) => a.n - b.n)
    .map((t) => t.f);
}

/** 1-based tile number of `<name>-<n>.png`, or 0 if the file is not a tile of `name`. */
function tileIndex(file: string, name: string): number {
  if (!file.startsWith(`${name}-`) || !file.endsWith('.png')) return 0;
  const mid = file.slice(name.length + 1, -'.png'.length);
  return /^\d+$/.test(mid) ? Number(mid) : 0;
}

/** Top offsets of every tile covering an image `height` px tall, plus whether the tail was cut. */
function tileOffsets(height: number): { tops: number[]; truncated: boolean } {
  const step = Math.max(1, TILE_HEIGHT - TILE_OVERLAP);
  const tops: number[] = [];
  for (let top = 0; top < height; top += step) {
    // A trailing sliver shorter than the overlap is already fully inside the previous tile.
    if (tops.length && height - top <= TILE_OVERLAP) break;
    tops.push(top);
  }
  if (!tops.length) tops.push(0);
  const truncated = tops.length > MAX_TILES;
  return { tops: truncated ? tops.slice(0, MAX_TILES) : tops, truncated };
}

/**
 * Slice every desktop screenshot into readable, viewport-height tiles under `source/tiles/`.
 * Returned paths are relative to the SITE dir (`source/tiles/<name>-1.png`) because that is the
 * agent's cwd — note pages.json stores `screenshot` relative to `source/` instead. Best-effort:
 * a page that fails to tile comes back with no tiles and the prompt falls back to its full PNG.
 */
async function tileScreenshots(
  pages: Page[],
  sourceDir: string,
  onLog: (l: string) => void,
): Promise<{ page: Page; tiles: string[] }[]> {
  const shot = pages.filter((p) => p.screenshot);
  if (!shot.length) return [];
  const tilesDir = path.join(sourceDir, 'tiles');
  fs.mkdirSync(tilesDir, { recursive: true });
  onLog(`Capturing design — slicing ${shot.length} screenshots into readable tiles…`);

  const out: { page: Page; tiles: string[] }[] = [];
  for (const p of shot) {
    const name = p.md.replace(/\.md$/, '');
    const src = path.join(sourceDir, p.screenshot as string);
    const rel = (file: string) => path.posix.join('source', 'tiles', file);
    try {
      const srcMtime = fs.statSync(src).mtimeMs;
      const cached = existingTiles(tilesDir, name);
      if (cached.length && fs.statSync(path.join(tilesDir, cached[0])).mtimeMs >= srcMtime) {
        onLog(`Capturing design — tiles for ${name} cached`);
        out.push({ page: p, tiles: cached.map(rel) });
        continue;
      }
      // Stale tiles from an older, taller screenshot would otherwise survive as phantom slices.
      for (const file of cached) fs.rmSync(path.join(tilesDir, file), { force: true });

      const { width, height } = await sharp(src).metadata();
      if (!width || !height) throw new Error('could not read the image dimensions');
      const { tops, truncated } = tileOffsets(height);
      const tiles: string[] = [];
      for (const [i, top] of tops.entries()) {
        const file = `${name}-${i + 1}.png`;
        await sharp(src)
          .extract({ left: 0, top, width, height: Math.min(TILE_HEIGHT, height - top) })
          .png()
          .toFile(path.join(tilesDir, file));
        tiles.push(rel(file));
      }
      out.push({ page: p, tiles });
      onLog(
        `Capturing design — tiled ${name} into ${tiles.length} slice${tiles.length === 1 ? '' : 's'}` +
          (truncated ? ` (capped at ${MAX_TILES}; the bottom of the page was skipped)` : ''),
      );
    } catch (err) {
      // Tiling is a readability aid: losing it costs fidelity, not the run.
      onLog(
        `Capturing design — tiling ${name} failed (${err instanceof Error ? err.message : err}), ` +
          'using the full screenshot',
      );
      out.push({ page: p, tiles: [] });
    }
  }
  return out;
}

// ------------------------------------------------- tool_use -> log line table

const BASENAME = (f: string) => path.basename(f ?? '');

/** Turn one SDK tool_use event into a short human line, or null to skip it. */
function describeTool(name: string, input: any): string | null {
  const file: string = input?.file_path ?? input?.path ?? '';
  const cmd: string = input?.command ?? '';

  if (name === 'Task') {
    const type = input?.subagent_type ?? '';
    const what = (input?.description ?? '').trim();
    if (type === 'qa') return null; // step 5 marker handles this
    if (type === 'page-builder') return `Building page: ${what || 'page'}…`;
    return what ? `Delegating: ${what}…` : null;
  }

  if (name === 'Bash') {
    if (/next build|npm run build/.test(cmd)) return 'Building site…';
    if (/npm (install|i)\b/.test(cmd)) return 'Installing dependencies…';
    if (/\bcurl\b|\bwget\b/.test(cmd)) return 'Downloading assets…';
    return null;
  }

  if (name === 'WebFetch') return 'Reading the original site’s CSS…';

  if (name === 'Read' && /\.png$/i.test(file)) {
    // Drop a tile's trailing -<n> so all 7 tiles of one page collapse into one line in the UI.
    return `Studying design: ${BASENAME(file).replace(/\.png$/i, '').replace(/-\d+$/, '')}…`;
  }

  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') {
    const m = file.match(/app\/(?:src\/)?app\/(.*)page\.tsx$/);
    if (m) {
      const route = m[1].replace(/\/$/, '');
      return route ? `Creating ${route.replace(/\//g, ' ')} page…` : 'Creating homepage…';
    }
    if (/layout\.tsx$/.test(file)) return 'Creating shared layout…';
    if (/globals\.css$/.test(file)) return 'Writing design tokens…';
    const comp = file.match(/components\/(\w+)\.tsx$/);
    if (comp) return `Creating ${comp[1]} component…`;
    if (/design-tokens/.test(file)) return 'Extracting design tokens…';
    return null;
  }

  return null;
}

// --------------------------------------------------- step 4/5: agent rebuild

const QA_MARKER = 'QA_PASS_START';

const pageBuilderPrompt = `You build ONE page of a website clone as part of a larger rebuild.

You are given: the page's route, its source markdown file, and its desktop screenshot as a list of
\`source/tiles/<name>-N.png\` tiles — full-resolution, viewport-height slices of the page, 1-indexed
top to bottom (and sometimes a mobile screenshot). Before you write anything, read
\`source/design-tokens.md\` with the Read tool — it is the shared design-tokens note for the site.

Rules:
- The screenshot is the spec; the markdown is the content. Read the tiles in order with the Read
  tool and look at them — they are the page top to bottom at full resolution. Take every word of
  copy verbatim from the markdown. No lorem ipsum, no
  "Service description here", no invented names. If the original has 12 testimonials, build 12.
- The tiles already exist and are final. Do NOT crop, resize, convert or otherwise process any
  image; do NOT write a cropping or slicing script; do NOT install or invoke ffmpeg, ImageMagick,
  sips or any other image tool. Read the tiles you were given; that is the entire workflow.
- Use ONLY the tokens, fonts, colors and utility classes from the design-tokens note, and the
  existing shared Header/Footer/layout components. Do NOT create your own header or footer,
  do NOT redefine fonts or colors, do NOT edit globals.css or layout.tsx or any shared component.
- Write exactly the one page file you were asked for (plus page-local client components in the
  same folder if a section needs interactivity).
- Images: download every image this page needs into app/public/ (curl -sL the original URL to
  app/public/<descriptive-name>.<ext>) and reference it as "/<descriptive-name>.<ext>". NEVER
  hot-link the original domain. Use plain <img> with width/height or aspect-ratio classes; do not
  use next/image.
- Mobile-first: multi-column grids collapse to one column, hero text scales down, nothing
  overflows horizontally at 390px.
- Export \`metadata\` with the page's real title.

Report back: the file you created, the images you downloaded, and anything from the screenshot
you could not reproduce. Keep it to a few lines.`;

const qaPrompt = `You are the QA reviewer for a website clone. Be exacting; you are the last gate.

Run this checklist and FIX what you find (you may edit any file):
1. \`cd app && npx next build\` — it MUST exit 0. Fix every error and type error. Re-run until clean.
2. \`app/out/\` must contain an .html file for every page in source/pages.json. A missing one means
   that route was never built — build it.
3. NO HOT-LINKING. Grep the whole app/ tree (including app/out/) for the original domain in any
   src=, srcset=, href= on <link rel=preload>, or CSS url(). Every hit is a bug: download the asset
   into app/public/ and point at the local path. Report zero remaining hits.
4. Grep for placeholder junk — "lorem", "TODO", "placeholder", "example.com", href="#" in nav —
   and replace with real values from the markdown.
5. Header and Footer appear exactly once on every page.

If you need to serve app/out/ for any check, use port 4998 ONLY (never 3999 — that is the clone
tool's own UI) and kill your server before you finish reporting.

Report: routes built, build status, hot-link count (must be 0), and anything you could not fix.`;

function orchestratorPrompt(
  target: string,
  pages: Page[],
  mobile: { page: Page; file: string }[],
  tiles: { page: Page; tiles: string[] }[],
) {
  const hostedClause = hosted()
    ? ' `next.config.ts` also carries a `basePath` for hosted preview — do not remove or edit it.'
    : '';
  const mobileFor = (p: Page) => mobile.find((m) => m.page.url === p.url)?.file;
  const tileCount = (p: Page) => tiles.find((t) => t.page.url === p.url)?.tiles.length ?? 0;
  // The naming rule is spelled out once, in the source/ inventory above; the page list carries
  // only the range. A page whose tiling failed falls back to its one full-page PNG.
  const shotsFor = (p: Page) => {
    const n = tileCount(p);
    return n ? `source/tiles/${p.md.replace(/\.md$/, '')}-1..${n}.png` : p.screenshot ?? 'NO SCREENSHOT';
  };
  return `You are cloning the live website ${target} into a Next.js 15 + Tailwind v4 static site.

Everything extracted for you is in \`source/\` (relative to your cwd):
- \`source/pages.json\` — index of every crawled page: { url, title, md, screenshot }
- \`source/<name>.md\` — full-page markdown (nav, body, footer, all link hrefs, all image URLs)
- \`source/tiles/<name>-N.png\` — that page's DESKTOP screenshot, PRE-CROPPED FOR YOU into
  full-resolution, viewport-height slices, 1-indexed top to bottom (\`-1\` is the top of the page,
  and the page list below gives each page's tile count). READ THESE with the Read tool, in order.
  They are your design source of truth.
- \`source/<name>.png\` — the same desktop screenshot as one tall image. Use it only for a page the
  list below shows with no tiles: read whole it is downscaled until the body copy is unreadable.
- \`source/<name>.mobile.png\` — full-page MOBILE (390px) screenshot for a few key pages.

Pages to rebuild (${pages.length}):
${pages
  .map(
    (p) =>
      `- ${p.url} -> ${p.md} / ${shotsFor(p)}${mobileFor(p) ? ` / ${mobileFor(p)}` : ''} — ${p.title}`,
  )
  .join('\n')}

Your output goes in \`app/\`. Create the whole project there.

## Ground rules

1. **The screenshots are the spec, the markdown is the content.** Never invent layout from the
   markdown alone — read that page's tiles in order and look at them. Never invent copy from the
   screenshot — take verbatim text from the markdown. Both, for every page.
2. **The tiles are already cropped for you.** Do NOT crop, resize, convert or otherwise process any
   image; do NOT write a cropping or slicing script; do NOT install or invoke ffmpeg, ImageMagick,
   sips or any other image tool. Reading the tiles with the Read tool is the entire workflow.
3. **Real content only.** Every heading, paragraph, service description, testimonial, phone
   number, address and hours block is verbatim from the markdown. No lorem ipsum, no placeholder
   names. If the original page has 12 testimonials, build 12.
4. **Real images, downloaded locally.** Download every referenced image into \`app/public/\`
   (\`curl -sL '<original url>' -o app/public/<descriptive-name>.<ext>\`) and reference it as
   \`/<descriptive-name>.<ext>\`. NEVER hot-link the original domain — no \`src\`, \`srcset\`,
   \`<link rel="preload">\` or CSS \`url()\` may point at ${new URL(target).hostname}. Same for fonts:
   self-host or use the closest \`next/font/google\` match. Use plain \`<img>\` with explicit
   width/height or aspect-ratio classes; do not use next/image.

## Process — follow in order

### Phase 1 — Extract the real CSS tokens (MANDATORY, do this first)
Do NOT eyeball the colors. Fetch the truth:
- Fetch the original HTML: \`curl -sL ${target} -o source/original.html\`.
- Find every linked stylesheet in that HTML (\`<link rel="stylesheet" href="...">\`, plus any
  inline \`<style>\` blocks) and download each CSS bundle into \`source/css/\`.
- Grep those bundles for the real values and write them to \`source/design-tokens.md\`:
  - every \`font-family\` stack actually used, and where (headings vs body vs buttons), plus the
    \`@font-face\`/Google-Fonts imports and the weights loaded;
  - the exact brand colors — hex/rgb/hsl — for background, surface, text, muted text, primary,
    primary hover, accent, borders; note CSS custom properties verbatim;
  - every \`@keyframes\` block and the elements that use it (animation name, duration, easing);
  - container max-widths, section padding rhythm, border radii, shadow values, button styles.
- Cross-check the token values against the screenshots and fix anything the CSS does not explain.
- \`source/design-tokens.md\` is the contract every page-builder receives. It must be complete
  enough to build from without re-reading the CSS.

### Phase 2 — Scaffold
\`app/package.json\`, \`app/next.config.ts\`, \`app/postcss.config.mjs\` and \`app/tsconfig.json\`
already exist — do NOT recreate, edit or reformat them (do NOT run create-next-app either; it is
interactive and slow). In particular, leave \`next.config.ts\`'s \`output: 'export'\` alone; the
export-completeness check and the local preview server both depend on it.${hostedClause} Your job in this phase:
- \`src/app/globals.css\`: \`@import "tailwindcss";\` then an \`@theme\` block defining the color and
  font tokens from \`source/design-tokens.md\` verbatim, plus the \`@keyframes\` you extracted.
- Fonts via \`next/font/google\` in the root layout — closest match to the real font stack.
- Run \`npm install\` in \`app/\`.

### Phase 3 — Shared chrome (you build this yourself, before any fan-out)
Build \`src/components/Header.tsx\` and \`src/components/Footer.tsx\` (plus TopBar / MobileNav as the
screenshots require) and wire them into \`src/app/layout.tsx\` so every page inherits them. Nav links
point at your real internal routes, matching the original site's pathnames. Download the logo and
any header/footer imagery into \`app/public/\`. Build the homepage \`src/app/page.tsx\` yourself so the
page-builders have a worked example to match.

### Phase 4 — Fan out one page-builder per remaining page (IN PARALLEL)
For every entry in pages.json except the homepage, invoke the \`page-builder\` subagent with the
Task tool. **Send all of them in a single message so they run in parallel.**
Each delegation prompt must contain, inline:
- the route to create (preserve the original pathname: \`/services/service\` ->
  \`src/app/services/service/page.tsx\`), and the page title for \`metadata\`;
- the source file names: \`source/<name>.md\`, and that page's tile paths spelled out in order
  (\`source/tiles/<name>-1.png\`, \`source/tiles/<name>-2.png\`, … up to the count in the page list
  above) the same way you pass \`source/design-tokens.md\` — a path, not its contents. Only if the
  page list shows that page with no tiles, pass \`source/<name>.png\` instead. Plus the
  \`.mobile.png\` if listed above;
- the path \`source/design-tokens.md\` and an instruction to read it with the Read tool before
  writing anything (subagents do not share your context, so they must read it themselves — do not
  paste its contents);
- the exact import paths and prop signatures of the shared components, and the note that
  layout.tsx already renders Header and Footer so the page must NOT render them again;
- a pointer to \`src/app/page.tsx\` as the reference for style and structure.
Every URL in pages.json must resolve when you are done.

### Phase 5 — Responsive sweep
Mobile-first Tailwind. Use the \`.mobile.png\` screenshots as the reference for the pages that have
one, and apply the same patterns to the rest: multi-column grids collapse to one column, the
desktop nav collapses into a working hamburger (client component with useState), hero text scales
down, fixed-width elements become fluid. Nothing may overflow horizontally at 390px.

### Phase 6 — QA
Run exactly this command first, on its own: \`echo ${QA_MARKER}\`
Then invoke the \`qa\` subagent with the Task tool to run the full verification pass. Give it the
route list and tell it \`next build\` must exit 0 and hot-link count must be 0. Apply whatever it
reports back that it could not fix itself, then re-run \`cd app && npx next build\` to confirm it is
still clean.

Report at the end: routes built, images downloaded, anything you could not reproduce, build status.`;
}

// Boilerplate the orchestrator prompt used to spell out in full and pay Opus to retype every
// run. Nothing here depends on the crawled site — that stays the agent's job (globals.css,
// fonts, layout.tsx, components).
const SCAFFOLD_PACKAGE_JSON = {
  name: 'clone',
  private: true,
  version: '0.1.0',
  scripts: {
    dev: 'next dev',
    build: 'next build',
    start: 'next start',
  },
  dependencies: {
    next: '^15',
    react: '^19',
    'react-dom': '^19',
  },
  devDependencies: {
    typescript: '^5',
    '@types/react': '^19',
    '@types/node': '^22',
    tailwindcss: '^4',
    '@tailwindcss/postcss': '^4',
  },
};

const SCAFFOLD_NEXT_CONFIG = `export default { output: 'export', images: { unoptimized: true } };\n`;

// Hosted mode bakes the nginx mount point into every URL Next emits (chunks, CSS, next/font,
// <Link> hrefs) so the export works when served from /preview/<domain>/ instead of the site
// root. basePath must not end with '/' — serve.ts's rebaseExport strips the same trailing slash
// before comparing against it.
function nextConfigFor(domain: string): string {
  if (!hosted()) return SCAFFOLD_NEXT_CONFIG;
  return `export default { output: 'export', images: { unoptimized: true }, basePath: '/preview/${domain}' };\n`;
}

const SCAFFOLD_POSTCSS_CONFIG = `export default { plugins: { '@tailwindcss/postcss': {} } };\n`;

const SCAFFOLD_TSCONFIG = {
  compilerOptions: {
    target: 'ES2017',
    lib: ['dom', 'dom.iterable', 'esnext'],
    allowJs: true,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    esModuleInterop: true,
    module: 'esnext',
    moduleResolution: 'bundler',
    resolveJsonModule: true,
    isolatedModules: true,
    jsx: 'preserve',
    incremental: true,
    plugins: [{ name: 'next' }],
    paths: { '@/*': ['./src/*'] },
  },
  include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
  exclude: ['node_modules'],
};

// Writes the four boilerplate files the orchestrator prompt used to dictate verbatim.
// next.config.ts/postcss.config.mjs/tsconfig.json are pure boilerplate and always overwritten;
// package.json is written only if missing, since `npm install` rewrites it and a re-run may
// legitimately carry a dependency the agent added plus a lockfile that matches it.
function scaffold(siteDir: string, onLog: (l: string) => void) {
  const appDir = path.join(siteDir, 'app');
  // The site directory's own basename, not a re-parse of the target URL — sites/<domain>/app is
  // the one place the domain is already pinned (runClone derives siteDir from it the same way).
  const domain = path.basename(siteDir);

  const packageJsonPath = path.join(appDir, 'package.json');
  const packageJsonExisted = fs.existsSync(packageJsonPath);
  if (!packageJsonExisted) {
    fs.writeFileSync(packageJsonPath, JSON.stringify(SCAFFOLD_PACKAGE_JSON, null, 2) + '\n');
  }

  fs.writeFileSync(path.join(appDir, 'next.config.ts'), nextConfigFor(domain));
  fs.writeFileSync(path.join(appDir, 'postcss.config.mjs'), SCAFFOLD_POSTCSS_CONFIG);
  fs.writeFileSync(path.join(appDir, 'tsconfig.json'), JSON.stringify(SCAFFOLD_TSCONFIG, null, 2) + '\n');

  onLog(
    `Rebuilding site — scaffolded app/ (${packageJsonExisted ? 'kept existing' : 'wrote'} package.json, next.config.ts, postcss.config.mjs, tsconfig.json)`,
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

async function rebuild(
  target: string,
  siteDir: string,
  pages: Page[],
  mobile: { page: Page; file: string }[],
  tiles: { page: Page; tiles: string[] }[],
  onLog: (l: string) => void,
  abortController?: AbortController,
) {
  fs.mkdirSync(path.join(siteDir, 'app'), { recursive: true });
  scaffold(siteDir, onLog);
  onLog(`Rebuilding site — ${pages.length} pages, design system first then parallel page builders`);

  let qaStarted = false;
  let last = '';
  const log = (line: string) => {
    if (line === last) return; // collapse repeats (e.g. next build re-runs)
    last = line;
    onLog(line);
  };

  // Live progress: total_cost_usd only ever lands on the session's terminal result (the SDK's
  // own doc: "exactly one result message per turn"), so it can't tick during the run — the only
  // per-message signal available mid-rebuild is the token usage each Task subagent (page-builder,
  // qa) reports on task_progress/task_notification. Track the latest total per task (these report
  // that task's running total, not a delta) and surface the sum at most every ~30s. Dollars stay
  // exact-only, from the terminal result once the loop ends.
  const taskTokens = new Map<string, number>();
  let latestTokens = 0;
  let lastEmittedTokens = 0;
  const emitTokens = () => {
    if (latestTokens <= 0) return;
    lastEmittedTokens = latestTokens;
    onLog(`Rebuilding site — ~${formatTokenCount(latestTokens)} tokens so far`);
  };
  const progressTimer = setInterval(() => {
    if (latestTokens !== lastEmittedTokens) emitTokens();
  }, 30_000);

  // The stream's LAST 'result' message is the session's own terminal result by definition; any
  // 'result' superseded by a later one turns out to have belonged to a nested subagent, not the
  // session. So only report done/throw once the loop ends and we know which one that was —
  // otherwise every subagent completion re-broadcasts "done", and one failed subagent (a
  // non-'success' subtype) aborts the whole rebuild.
  let finalResult: Extract<SDKMessage, { type: 'result' }> | null = null;

  try {
    for await (const m of query({
      prompt: orchestratorPrompt(target, pages, mobile, tiles),
      options: {
        cwd: siteDir,
        model: 'opus',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 200,
        abortController,
        // Bounded, not off: the orchestrator's work is mostly mechanical (extract tokens,
        // scaffold, delegate, grep) rather than open-ended reasoning, so it doesn't need a large
        // thinking budget, but 0 would disable thinking outright on models that honor this field.
        maxThinkingTokens: 4096,
        agents: {
          'page-builder': {
            description: 'Builds one page of the clone from its markdown + screenshot + design tokens.',
            model: 'sonnet',
            prompt: pageBuilderPrompt,
          },
          qa: {
            description: 'QA: verifies the build, export completeness, and hot-linking/placeholder checks.',
            model: 'sonnet',
            prompt: qaPrompt,
          },
        },
      },
    })) {
      if (m.type === 'assistant') {
        for (const b of m.message.content as any[]) {
          if (b.type !== 'tool_use') continue;
          const isQa =
            (b.name === 'Bash' && String(b.input?.command ?? '').includes(QA_MARKER)) ||
            (b.name === 'Task' && b.input?.subagent_type === 'qa');
          if (isQa && !qaStarted) {
            qaStarted = true;
            onLog('Verifying against original — visual QA pass on every page…');
            continue;
          }
          const line = describeTool(b.name, b.input);
          if (line) log(line);
        }
      } else if (m.type === 'system' && (m.subtype === 'task_progress' || m.subtype === 'task_notification')) {
        if (m.usage) {
          taskTokens.set(m.task_id, m.usage.total_tokens);
          latestTokens = [...taskTokens.values()].reduce((sum, n) => sum + n, 0);
        }
      } else if (m.type === 'result') {
        if (finalResult && finalResult.subtype !== 'success') {
          onLog(`Rebuilding site — a page builder ended with "${finalResult.subtype}"`);
        }
        finalResult = m;
      }
    }
  } finally {
    clearInterval(progressTimer);
  }

  if (finalResult) {
    if (finalResult.subtype !== 'success') {
      throw new Error(`Rebuilding site failed: the agent session ended with "${finalResult.subtype}".`);
    }
    onLog(
      `Rebuilding site — done in ${Math.round(finalResult.duration_ms / 1000)}s` +
        (finalResult.total_cost_usd ? ` ($${finalResult.total_cost_usd.toFixed(2)})` : ''),
    );
  }

  if (!qaStarted) onLog('Verifying against original — QA pass did not report in; check the build manually');
}

// --------------------------------------------------- step 6: export completeness

/**
 * Mirrors the route -> file convention page-builders were told to use (orchestratorPrompt
 * above): pathname "/a/b" -> src/app/a/b/page.tsx -> out/a/b.html or out/a/b/index.html
 * (next export can produce either shape). The root page is out/index.html.
 */
function missingExportRoutes(appDir: string, pages: Page[]): string[] {
  const missing: string[] = [];
  for (const p of pages) {
    const clean = new URL(p.url).pathname.replace(/^\/|\/$/g, '');
    const candidates = clean
      ? [path.join('out', `${clean}.html`), path.join('out', clean, 'index.html')]
      : [path.join('out', 'index.html')];
    if (!candidates.some((f) => fs.existsSync(path.join(appDir, f)))) {
      missing.push(clean ? `/${clean}` : '/');
    }
  }
  return missing;
}

// ---------------------------------------------------------------- public API

export type PageProposal = {
  pages: { url: string; title: string; hasScreenshot: boolean }[];
  filtered: FilteredLink[];
};

export type CostEstimate = { pages: number; estimatedCost: number };

// Rough per-page heuristic, not measured from real runs — refine once Phase 2.2's
// checkpoint has seen actual rebuild costs across a range of page counts.
const BASE_REBUILD_COST = 0.5;
const EST_COST_PER_PAGE = 0.15;

export type RunCloneOptions = {
  /**
   * Called after capture, before the expensive rebuild. Resolves to the
   * approved URL subset, or null/empty to cancel. Omit to keep today's
   * unattended behaviour (used by CLONE_DRY_RUN and script callers).
   */
  onReview?: (proposal: PageProposal) => Promise<string[] | null>;
  /**
   * Called after the page review (if any), before the rebuild agent session
   * starts. Resolves true to proceed, false to cancel. Omit to keep today's
   * unattended behaviour.
   */
  onConfirm?: (estimate: CostEstimate) => Promise<boolean>;
  /** Aborts the rebuild session and any in-flight capture/publish work. */
  abortController?: AbortController;
};

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error('Stopped by user');
}

export async function runClone(
  url: string,
  onLogOut: (line: string) => void,
  options?: RunCloneOptions,
): Promise<void> {
  let target: string;
  try {
    target = new URL(url).toString();
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }

  const domain = new URL(target).hostname.replace(/^www\./, '');
  const siteDir = path.resolve('sites', domain);
  const sourceDir = path.join(siteDir, 'source');
  fs.mkdirSync(sourceDir, { recursive: true });

  const signal = options?.abortController?.signal;

  // Append-mode: re-running the same domain adds to run.log rather than truncating it, so a
  // history of past attempts survives.
  const logStream = fs.createWriteStream(path.join(siteDir, 'run.log'), { flags: 'a' });
  const onLog = (line: string) => {
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
    onLogOut(line);
  };

  try {
    const links = await mapPages(target, onLog);
    assertNotAborted(signal);
    const { picked, filtered } = pickPagesDetailed(target, links);
    const pages = await crawlPages(picked, sourceDir, onLog);
    assertNotAborted(signal);
    const mobile = await captureMobile(pages, sourceDir, onLog);
    assertNotAborted(signal);
    const tiles = await tileScreenshots(pages, sourceDir, onLog);
    assertNotAborted(signal);

    if (process.env.CLONE_DRY_RUN) {
      onLog('Dry run (CLONE_DRY_RUN=1) — stopping after capture.');
      return;
    }

    let buildPages = pages;
    if (options?.onReview) {
      onLog('Capturing design — awaiting review…');
      const proposal: PageProposal = {
        pages: pages.map((p) => ({ url: p.url, title: p.title, hasScreenshot: !!p.screenshot })),
        filtered,
      };
      const approved = await options.onReview(proposal);
      if (!approved || !approved.length) {
        onLog('Cancelled — no pages approved.');
        return;
      }
      const approvedSet = new Set(approved);
      buildPages = pages.filter((p) => approvedSet.has(p.url));
    }

    if (options?.onConfirm) {
      const estimate: CostEstimate = {
        pages: buildPages.length,
        estimatedCost: Math.round((BASE_REBUILD_COST + buildPages.length * EST_COST_PER_PAGE) * 100) / 100,
      };
      onLog(`Rebuilding site — estimated cost ~$${estimate.estimatedCost.toFixed(2)} for ${estimate.pages} pages — awaiting approval…`);
      const proceed = await options.onConfirm(estimate);
      if (!proceed) {
        onLog('Cancelled — rebuild not approved.');
        return;
      }
    }

    await rebuild(target, siteDir, buildPages, mobile, tiles, onLog, options?.abortController);

    const appDir = path.join(siteDir, 'app');
    onLog('Publishing local preview — building static export…');
    const serve = await import('./serve.js').catch((err) => {
      throw new Error(`Publishing local preview failed: could not load ./serve.ts — ${err?.message ?? err}`);
    });
    if (typeof serve.publishPreview !== 'function') {
      throw new Error('Publishing local preview failed: ./serve.ts does not export publishPreview().');
    }
    const previewUrl = await serve.publishPreview(appDir, onLog, (dir) => missingExportRoutes(dir, buildPages), signal);
    onLog(`Publishing local preview → ${previewUrl}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logStream.write(`[${new Date().toISOString()}] ERROR: ${message}\n`);
    throw err;
  } finally {
    logStream.end();
  }
}
