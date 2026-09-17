# website-clone

URL in → local Next.js clone out. Three source files, no build step, no framework:

- `pipeline.ts` — the whole pipeline: Firecrawl map → crawl → screenshots + tiling →
  Agent SDK rebuild (orchestrator + per-page builders + QA) → preview.
- `server.ts` — the UI: one HTTP server, an inline HTML page, SSE progress. `tsx server.ts`.
- `serve.ts` — `next build` + preview publish (local `npx serve`, or nginx-served in
  hosted mode), plus stop/list.

`docs/HISTORY.md` holds the product context, decision rationale, and v2 roadmap — read it
before proposing structural changes. `docs/HOSTED.md` is the live-droplet ops runbook
(Ian applies it by hand; never execute it). `docs/archive/` is the completed v1 build
scaffolding, kept for provenance only.

## Ground rules

- **`bash scripts/gate.sh` must pass before you commit.** No exceptions. It runs
  `npx tsc --noEmit` and boots the UI on port 4999 for a smoke test.
- **NEVER start a long-running server or a clone job.** No `npm run ui`, no `tsx server.ts`
  left running, no `POST /api/clone` with a real URL, no `next build` of a client site. Real
  runs cost money and hit live client sites. The gate is the only server you start, and it
  kills itself. **Port 3999 is Ian's — never bind it.** Use 4999 (gate) or 4998 (anything
  ad hoc), and kill it before you finish. `npm run ui` is Ian's command, not yours.
- **Never touch `sites/`.** It holds real client runs. Read it if you need to understand
  the layout; never write, move, or delete anything in it. It is gitignored and must stay
  out of every commit. Need a real fixture? Copy it out to a temp dir.
- **No new dependencies.** The dep list is `@anthropic-ai/claude-agent-sdk`, `sharp`, and
  `tsx`, and it stays that way. Node's stdlib covers everything else. Do not edit
  `package.json`.
- **Never touch `.env`** or print its contents.

## The SSE step-name contract (the easiest thing to break)

`STEPS` in `server.ts` defines six canonical step names. `pipeline.ts` emits every log
line starting with the exact name of the step it belongs to, and the UI picks the active
step with `STEPS.findIndex(s => line.startsWith(s))`.

```
Mapping pages · Extracting content · Capturing design ·
Rebuilding site · Verifying against original · Publishing local preview
```

So: any log line you add or change must keep its step's exact prefix, and you must not
rename, reorder, or add to `STEPS`. A line like `Cost: $1.42` emitted mid-rebuild
silently resets the UI's progress; `Rebuilding site — $1.42 so far` is correct. New
*event types* (`review`, `confirm`, `stop`) are fine — they are separate SSE events and
never reach the log matcher. Related: `QA_MARKER` in `pipeline.ts` is how the UI learns
the QA step started — keep it working.

## Hosted mode

`HOSTED=1` (set by systemd on the droplet) switches preview publishing to nginx-served
`/preview/<domain>/` paths with `basePath` baked into the generated Next config. Local
behaviour with `HOSTED` unset must stay byte-for-byte unchanged — every hosted branch is
an `if` around existing code. Auth is nginx basic-auth; never add auth to `server.ts`.
The gate runs with `HOSTED` unset — never set it there.

## Commit

- Conventional commits, scoped to the file you changed:
  `fix(server): honour PORT env var`, `feat(pipeline): review gate before rebuild`.
- Commit only source. `sites/`, `logs/`, `.done/`, `node_modules/`, `*.log` and `.env*`
  are gitignored — if `git status` shows any of them, fix `.gitignore` rather than
  committing them.
- Push to `origin` on the current branch if a remote is configured.

## Commands

```bash
bash scripts/gate.sh     # the gate: tsc --noEmit + UI smoke test on 4999
npx tsc --noEmit         # typecheck alone, while iterating
```
