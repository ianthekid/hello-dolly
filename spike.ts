// Phase 0 spike: URL -> Firecrawl crawl -> Agent SDK rebuild as Next.js/Tailwind static site.
// usage: npx tsx spike.ts <url>
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';

process.loadEnvFile('.env');

const target = process.argv[2];
if (!target) throw new Error('usage: npx tsx spike.ts <url>');

const domain = new URL(target).hostname.replace(/^www\./, '');
const siteDir = path.resolve('sites', domain);
const sourceDir = path.join(siteDir, 'source');
const indexFile = path.join(sourceDir, 'pages.json');

type Page = { url: string; title: string; md: string; screenshot: string | null };

const slug = (url: string) => {
  const p = new URL(url).pathname.replace(/^\/|\/$/g, '');
  return p ? p.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() : 'home';
};

async function crawl(): Promise<Page[]> {
  if (fs.existsSync(indexFile)) {
    console.log('[crawl] cached, skipping');
    return JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  }
  const key = process.env.FIRECRAWL_API_KEY;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  console.log('[crawl] starting Firecrawl crawl of', target);
  const start = await fetch('https://api.firecrawl.dev/v2/crawl', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: target,
      limit: 15,
      scrapeOptions: {
        formats: ['markdown', { type: 'screenshot', fullPage: true }],
        onlyMainContent: false,
      },
    }),
  }).then((r) => r.json());
  if (!start.success) throw new Error('crawl start failed: ' + JSON.stringify(start));
  console.log('[crawl] job', start.id);

  let job: any;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    job = await fetch(start.url, { headers }).then((r) => r.json());
    console.log(`[crawl] ${job.status} ${job.completed}/${job.total}`);
    if (job.status !== 'scraping') break;
  }
  if (job.status !== 'completed') throw new Error('crawl failed: ' + JSON.stringify(job).slice(0, 500));

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
      const buf = Buffer.from((await fetch(d.screenshot).then((r) => r.arrayBuffer())) as ArrayBuffer);
      fs.writeFileSync(path.join(sourceDir, `${name}.png`), buf);
      shot = `${name}.png`;
    }
    pages.push({ url, title: d.metadata?.title ?? name, md: `${name}.md`, screenshot: shot });
    console.log('[crawl] saved', name, url);
  }
  fs.writeFileSync(indexFile, JSON.stringify(pages, null, 2));
  return pages;
}

const clonePrompt = (pages: Page[]) => `You are cloning the live website ${target} into a Next.js 15 + Tailwind v4 static site.

Everything you need has already been extracted for you into \`source/\`:
- \`source/pages.json\` — index of every crawled page: { url, title, md, screenshot }
- \`source/<name>.md\` — full-page markdown of that page (nav, body, footer, all link hrefs, all image URLs)
- \`source/<name>.png\` — FULL-PAGE desktop screenshot of that page. These are images. READ THEM with the Read tool. They are your design source of truth.

Pages to rebuild (${pages.length}):
${pages.map((p) => `- ${p.url} -> ${p.md} / ${p.screenshot ?? 'NO SCREENSHOT'} — ${p.title}`).join('\n')}

Your output goes in \`app/\` (relative to your cwd). Create the whole project there.

## Ground rules

1. **The screenshots are the spec, the markdown is the content.** Never invent layout from the markdown alone — open the PNG and look at it. Never invent copy from the screenshot — take verbatim text from the markdown. Both, for every page.

2. **Real content only.** Every heading, paragraph, service description, testimonial, phone number, address, and hours block must be copied verbatim from the markdown. No lorem ipsum, no "Service description here", no placeholder names. If the original page has 12 testimonials, build 12.

3. **Real images.** The markdown contains the original absolute image URLs. Hot-link them directly (\`<img src="https://...">\`). Do NOT use next/image for remote URLs (static export + unoptimized makes it pointless); plain \`<img>\` with explicit width/height or aspect-ratio classes. If an image URL is a Next.js \`/_next/image?url=...\` proxy URL, keep it as-is — it works when hot-linked. Never substitute a gray box or a stock placeholder for a real image.

## Process

### Phase 1 — Recon (do this before writing any code)
- Read \`source/pages.json\`, then read EVERY .md file and Read EVERY .png screenshot.
- From the screenshots, write down the design system explicitly before you build: exact brand colors (sample them from the screenshots — hex values), font families and their character (serif/sans, weights, letter-spacing, case), heading scale, body size, section vertical rhythm, container max-width, border radii, button shapes and fills, shadow style, and the overall visual mood.
- From the screenshots, identify the shared chrome: the top bar / header / nav (including logo, phone number, CTA button, and the mobile hamburger), and the footer. These are identical across pages — they become components.
- Map each page's sections top-to-bottom: hero, intro, cards grid, testimonial slider, gallery grid, CTA band, map, etc. Note for each whether it is full-bleed or contained, its background color, and its column count.

### Phase 2 — Scaffold
Create \`app/\` by hand (do not run create-next-app; it is interactive and slow). Exact files:
- \`package.json\` with deps: next@^15, react@^19, react-dom@^19; devDeps: typescript, @types/react, @types/node, tailwindcss@^4, @tailwindcss/postcss. Scripts: dev/build/start.
- \`next.config.ts\`: \`export default { output: 'export', images: { unoptimized: true } }\`
- \`postcss.config.mjs\`: \`export default { plugins: { '@tailwindcss/postcss': {} } }\`
- \`tsconfig.json\` (standard Next.js app-router config with the \`@/*\` path alias and the \`next\` plugin).
- \`src/app/globals.css\`: \`@import "tailwindcss";\` followed by an \`@theme\` block defining the brand color tokens and font tokens you sampled in Phase 1, so the whole site uses one palette.
- Fonts via \`next/font/google\` in the root layout — pick the closest Google font match to what you see in the screenshots.
- Then run \`npm install\` in \`app/\`.

### Phase 3 — Shared layout
Build \`src/components/Header.tsx\` and \`src/components/Footer.tsx\` (plus any TopBar / MobileNav) and wire them into \`src/app/layout.tsx\` so every page gets them automatically. The nav links must point at your real internal routes, matching the original site's URL paths.

### Phase 4 — Pages
One route per entry in pages.json, preserving the original pathname:
- \`/\` -> \`src/app/page.tsx\`
- \`/services/service\` -> \`src/app/services/service/page.tsx\`
- ...and so on for every page. Every URL in pages.json must resolve.
Build each page section by section against its screenshot. Match: background colors, section padding, heading sizes and weights, text alignment, image placement and crop, card layouts, button styles, divider/ornament elements. Aim for "a client would recognize this as their site", not a rough approximation.

Per-page metadata: export \`metadata\` with the page's real title from pages.json.

### Phase 5 — Responsive
Build mobile-first with Tailwind breakpoints. The screenshots are desktop-only, so use judgment for mobile: multi-column grids collapse to one column, the desktop nav collapses into a working hamburger menu (a client component with useState), hero text scales down, fixed-width elements become fluid. Nothing may overflow horizontally at 390px.

### Phase 6 — QA pass (mandatory, do not skip)
1. \`cd app && npx next build\` — it MUST exit 0. Fix every error and every type error. Re-run until clean.
2. Confirm \`app/out/\` contains an .html file for every page in pages.json. If one is missing, that route was never built — go build it.
3. Re-open each screenshot next to your page code and check, per page: is every section from the screenshot present? Is every image present with a real src? Is the text verbatim? Fix what's missing.
4. Grep your own output for placeholder junk — "lorem", "TODO", "placeholder", "example.com", "#" as a nav href — and replace with real values.
5. Check that Header and Footer are used on every page and that no page duplicates them.

Report at the end: routes built, anything from the original you could not reproduce, and the build status.`;

async function clone(pages: Page[]) {
  console.log('[clone] starting Agent SDK session in', siteDir);
  fs.mkdirSync(path.join(siteDir, 'app'), { recursive: true });
  const brief = (v: any) =>
    JSON.stringify(v).length > 160 ? JSON.stringify(v).slice(0, 160) + '…' : JSON.stringify(v);

  for await (const m of query({
    prompt: clonePrompt(pages),
    options: {
      cwd: siteDir,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 500,
    },
  })) {
    if (m.type === 'assistant') {
      for (const b of m.message.content as any[]) {
        if (b.type === 'tool_use') console.log(`  [${b.name}]`, brief(b.input));
        if (b.type === 'text' && b.text.trim()) console.log('  >', b.text.trim().slice(0, 500));
      }
    } else if (m.type === 'result') {
      console.log('[clone]', m.subtype, `${Math.round(m.duration_ms / 1000)}s $${m.total_cost_usd?.toFixed(2)}`);
    }
  }
}

const pages = await crawl();
console.log(`[crawl] ${pages.length} pages in ${sourceDir}`);
await clone(pages);
console.log('[done] app at', path.join(siteDir, 'app'));
