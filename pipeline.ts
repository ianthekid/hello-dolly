// Phase 1 pipeline: URL -> Firecrawl map/crawl/screenshots -> Agent SDK rebuild -> local preview.
// Every one of the 6 canonical steps emits an onLog line starting with its exact step name.
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional when FIRECRAWL_API_KEY is already in the environment.
}

type Page = { url: string; title: string; md: string; screenshot: string | null };

const FIRECRAWL = 'https://api.firecrawl.dev/v2';
const MAX_PAGES = 30;
const MOBILE_SHOTS = 3;

const slug = (url: string) => {
  const p = new URL(url).pathname.replace(/^\/|\/$/g, '');
  return p ? p.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() : 'home';
};

function headers() {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('FIRECRAWL_API_KEY is not set (put it in .env at the project root).');
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function firecrawl(endpoint: string, body: unknown): Promise<any> {
  const res = await fetch(`${FIRECRAWL}${endpoint}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    throw new Error(`Firecrawl ${endpoint} failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

/** Download a Firecrawl screenshot (URL or data: URI) to disk. */
async function saveImage(src: string, file: string) {
  const buf = src.startsWith('data:')
    ? Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
    : Buffer.from((await fetch(src).then((r) => r.arrayBuffer())) as ArrayBuffer);
  fs.writeFileSync(file, buf);
  return buf.length;
}

// ---------------------------------------------------------------- step 1: map

async function mapPages(target: string, onLog: (l: string) => void): Promise<string[]> {
  const json = await firecrawl('/map', { url: target, limit: 100 });
  const links: string[] = (json.links ?? []).map((l: any) => (typeof l === 'string' ? l : l.url)).filter(Boolean);
  onLog(`Mapping pages… found ${links.length}`);
  return links;
}

/**
 * Pick the MAX_PAGES most representative URLs from the site map: shallow nav
 * pages (About, Services, Contact…) before deep ones, dated posts last — so a
 * capped clone gets the site's structure, not 13 news articles.
 */
export function pickPages(target: string, links: string[]): string[] {
  const host = new URL(target).hostname.replace(/^www\./, '');
  const seen = new Set<string>();
  const candidates: { url: string; score: number }[] = [];
  for (const link of links) {
    let u: URL;
    try {
      u = new URL(link);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, '') !== host) continue;
    const p = u.pathname.replace(/\/$/, '');
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|xml|txt)$/i.test(p) || /\/(feed|wp-json)\b/.test(p)) continue;
    const key = `${host}${p}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const depth = p.split('/').filter(Boolean).length;
    // ponytail: naive heuristic — depth + dated-post penalty; refine if a site's nav still gets crowded out
    const score = depth + (/\/20\d\d(\/|$)/.test(p) ? 100 : 0);
    candidates.push({ url: `${u.origin}${p || '/'}`, score });
  }
  candidates.sort((a, b) => a.score - b.score);
  const picked = candidates.slice(0, MAX_PAGES).map((c) => c.url);
  if (!picked.length) picked.push(target);
  return picked;
}

// ------------------------------------------------------ step 2: crawl content

async function crawlPages(
  urls: string[],
  sourceDir: string,
  onLog: (l: string) => void,
): Promise<Page[]> {
  const indexFile = path.join(sourceDir, 'pages.json');
  if (fs.existsSync(indexFile)) {
    const cached: Page[] = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    onLog(`Extracting content — reusing cached crawl (${cached.length} pages)`);
    return cached;
  }

  onLog(`Extracting content — scraping ${urls.length} selected pages…`);
  const start = await firecrawl('/batch/scrape', {
    urls,
    formats: ['markdown', { type: 'screenshot', fullPage: true }],
    onlyMainContent: false,
  });

  let job: any;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    job = await fetch(start.url, { headers: headers() }).then((r) => r.json());
    onLog(`Extracting content — ${job.completed ?? 0}/${job.total ?? '?'} pages`);
    if (job.status !== 'scraping') break;
  }
  if (job.status !== 'completed') {
    throw new Error(`Firecrawl crawl did not complete (status: ${job.status}).`);
  }

  fs.mkdirSync(sourceDir, { recursive: true });
  const pages: Page[] = [];
  for (const d of job.data as any[]) {
    const url = d.metadata?.sourceURL ?? d.metadata?.url;
    if (!url) continue;
    let name = slug(url);
    while (pages.some((p) => p.md === `${name}.md`)) name += '-x';
    fs.writeFileSync(path.join(sourceDir, `${name}.md`), d.markdown ?? '');
    let shot: string | null = null;
    if (d.screenshot) {
      await saveImage(d.screenshot, path.join(sourceDir, `${name}.png`));
      shot = `${name}.png`;
    }
    pages.push({ url, title: d.metadata?.title ?? name, md: `${name}.md`, screenshot: shot });
    onLog(`Extracting content — saved ${name}`);
  }
  if (!pages.length) throw new Error('Firecrawl returned no pages for this site.');
  fs.writeFileSync(indexFile, JSON.stringify(pages, null, 2));
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
      const json = await firecrawl('/scrape', {
        url: p.url,
        mobile: true,
        formats: [{ type: 'screenshot', fullPage: true }],
      });
      const src = json.data?.screenshot;
      if (!src) throw new Error('no screenshot in response');
      await saveImage(src, dest);
      shots.push({ page: p, file });
      onLog(`Capturing design — mobile ${name}`);
    } catch (err) {
      // A missing mobile shot degrades fidelity but must not kill the job.
      onLog(`Capturing design — mobile ${name} failed (${err instanceof Error ? err.message : err})`);
    }
  }
  return shots;
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
    return `Studying design: ${BASENAME(file).replace(/\.png$/i, '')}…`;
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

You are given: the page's route, its source markdown file, its full-page desktop screenshot
(and sometimes a mobile screenshot), and the shared design-tokens note.

Rules:
- The screenshot is the spec; the markdown is the content. Read the PNG with the Read tool and
  look at it. Take every word of copy verbatim from the markdown. No lorem ipsum, no
  "Service description here", no invented names. If the original has 12 testimonials, build 12.
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

const qaPrompt = `You are the visual QA reviewer for a website clone. Be exacting; you are the last gate.

Run this checklist and FIX what you find (you may edit any file):
1. \`cd app && npx next build\` — it MUST exit 0. Fix every error and type error. Re-run until clean.
2. \`app/out/\` must contain an .html file for every page in source/pages.json. A missing one means
   that route was never built — build it.
3. For each page: Read its source/<name>.png next to the page code. Is every section from the
   screenshot present, in order? Are colors, fonts, spacing and image placement a match? Is the
   text verbatim from the markdown? Fix what is missing or wrong.
4. Mobile: check the pages that have a source/<name>.mobile.png against the built mobile layout.
   Nothing may overflow horizontally at 390px; the hamburger menu must open and close.
5. NO HOT-LINKING. Grep the whole app/ tree (including app/out/) for the original domain in any
   src=, srcset=, href= on <link rel=preload>, or CSS url(). Every hit is a bug: download the asset
   into app/public/ and point at the local path. Report zero remaining hits.
6. Grep for placeholder junk — "lorem", "TODO", "placeholder", "example.com", href="#" in nav —
   and replace with real values from the markdown.
7. Header and Footer appear exactly once on every page.

If you need to serve app/out/ for any check, use port 4998 ONLY (never 3999 — that is the clone
tool's own UI) and kill your server before you finish reporting.

Report: routes built, build status, hot-link count (must be 0), and anything you could not fix.`;

function orchestratorPrompt(target: string, pages: Page[], mobile: { page: Page; file: string }[]) {
  const mobileFor = (p: Page) => mobile.find((m) => m.page.url === p.url)?.file;
  return `You are cloning the live website ${target} into a Next.js 15 + Tailwind v4 static site.

Everything extracted for you is in \`source/\` (relative to your cwd):
- \`source/pages.json\` — index of every crawled page: { url, title, md, screenshot }
- \`source/<name>.md\` — full-page markdown (nav, body, footer, all link hrefs, all image URLs)
- \`source/<name>.png\` — FULL-PAGE DESKTOP screenshot. These are images. READ THEM with the Read
  tool. They are your design source of truth.
- \`source/<name>.mobile.png\` — full-page MOBILE (390px) screenshot for a few key pages.

Pages to rebuild (${pages.length}):
${pages
  .map(
    (p) =>
      `- ${p.url} -> ${p.md} / ${p.screenshot ?? 'NO SCREENSHOT'}${
        mobileFor(p) ? ` / ${mobileFor(p)}` : ''
      } — ${p.title}`,
  )
  .join('\n')}

Your output goes in \`app/\`. Create the whole project there.

## Ground rules

1. **The screenshots are the spec, the markdown is the content.** Never invent layout from the
   markdown alone — open the PNG and look at it. Never invent copy from the screenshot — take
   verbatim text from the markdown. Both, for every page.
2. **Real content only.** Every heading, paragraph, service description, testimonial, phone
   number, address and hours block is verbatim from the markdown. No lorem ipsum, no placeholder
   names. If the original page has 12 testimonials, build 12.
3. **Real images, downloaded locally.** Download every referenced image into \`app/public/\`
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
Create \`app/\` by hand (do NOT run create-next-app; it is interactive and slow):
- \`package.json\`: deps next@^15, react@^19, react-dom@^19; devDeps typescript, @types/react,
  @types/node, tailwindcss@^4, @tailwindcss/postcss. Scripts dev/build/start.
- \`next.config.ts\`: \`export default { output: 'export', images: { unoptimized: true } }\`
- \`postcss.config.mjs\`: \`export default { plugins: { '@tailwindcss/postcss': {} } }\`
- \`tsconfig.json\`: standard Next.js app-router config with the \`@/*\` alias and the \`next\` plugin.
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
- the source file names: \`source/<name>.md\`, \`source/<name>.png\`, and the \`.mobile.png\` if listed above;
- the FULL contents of \`source/design-tokens.md\` (paste it — subagents do not share your context);
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

async function rebuild(
  target: string,
  siteDir: string,
  pages: Page[],
  mobile: { page: Page; file: string }[],
  onLog: (l: string) => void,
) {
  fs.mkdirSync(path.join(siteDir, 'app'), { recursive: true });
  onLog(`Rebuilding site — ${pages.length} pages, design system first then parallel page builders`);

  let qaStarted = false;
  let last = '';
  const log = (line: string) => {
    if (line === last) return; // collapse repeats (e.g. next build re-runs)
    last = line;
    onLog(line);
  };

  // Live cost: the SDK only guarantees total_cost_usd on 'result' messages, so track the
  // latest one we've seen and surface it at most every ~30s or on a several-cent jump —
  // whichever comes first — rather than only in the one summary line at the end.
  let latestCost = 0;
  let lastEmittedCost = 0;
  const emitCost = () => {
    if (latestCost <= 0) return;
    lastEmittedCost = latestCost;
    onLog(`Rebuilding site — $${latestCost.toFixed(2)} so far`);
  };
  const costTimer = setInterval(() => {
    if (latestCost !== lastEmittedCost) emitCost();
  }, 30_000);

  try {
    for await (const m of query({
      prompt: orchestratorPrompt(target, pages, mobile),
      options: {
        cwd: siteDir,
        model: 'opus',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 800,
        agents: {
          'page-builder': {
            description: 'Builds one page of the clone from its markdown + screenshot + design tokens.',
            model: 'sonnet',
            prompt: pageBuilderPrompt,
          },
          qa: {
            description: 'Visual QA: verifies the rebuilt site against the original screenshots and the build.',
            model: 'opus',
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
      } else if (m.type === 'result') {
        if (typeof m.total_cost_usd === 'number' && m.total_cost_usd > 0) {
          latestCost = m.total_cost_usd;
          if (latestCost - lastEmittedCost > 0.03) emitCost();
        }
        if (m.subtype !== 'success') {
          throw new Error(`Rebuilding site failed: the agent session ended with "${m.subtype}".`);
        }
        onLog(
          `Rebuilding site — done in ${Math.round(m.duration_ms / 1000)}s` +
            (m.total_cost_usd ? ` ($${m.total_cost_usd.toFixed(2)})` : ''),
        );
      }
    }
  } finally {
    clearInterval(costTimer);
  }

  if (!qaStarted) onLog('Verifying against original — QA pass did not report in; check the build manually');
}

// ---------------------------------------------------------------- public API

export async function runClone(url: string, onLogOut: (line: string) => void): Promise<void> {
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

  // Append-mode: re-running the same domain adds to run.log rather than truncating it, so a
  // history of past attempts survives.
  const logStream = fs.createWriteStream(path.join(siteDir, 'run.log'), { flags: 'a' });
  const onLog = (line: string) => {
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
    onLogOut(line);
  };

  try {
    const links = await mapPages(target, onLog);
    const pages = await crawlPages(pickPages(target, links), sourceDir, onLog);
    const mobile = await captureMobile(pages, sourceDir, onLog);

    if (process.env.CLONE_DRY_RUN) {
      onLog('Dry run (CLONE_DRY_RUN=1) — stopping after capture.');
      return;
    }

    await rebuild(target, siteDir, pages, mobile, onLog);

    const appDir = path.join(siteDir, 'app');
    onLog('Publishing local preview — building static export…');
    const serve = await import('./serve.js').catch((err) => {
      throw new Error(`Publishing local preview failed: could not load ./serve.ts — ${err?.message ?? err}`);
    });
    if (typeof serve.publishPreview !== 'function') {
      throw new Error('Publishing local preview failed: ./serve.ts does not export publishPreview().');
    }
    const previewUrl = await serve.publishPreview(appDir, onLog);
    onLog(`Publishing local preview → ${previewUrl}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logStream.write(`[${new Date().toISOString()}] ERROR: ${message}\n`);
    throw err;
  } finally {
    logStream.end();
  }
}
