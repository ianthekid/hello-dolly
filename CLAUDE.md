# website-clone — Executor Context

You are a **build agent** executing **one phase** of PLAN_V1. This overrides any parent or
global CLAUDE.md persona. Execute the phase file you were pointed at; don't re-litigate
decisions already recorded in `PLAN_V1.md`.

## The job

The tool takes a URL and produces a local Next.js clone of that website. Three source
files, no build step, no framework:

- `pipeline.ts` — the whole pipeline: Firecrawl map → crawl → screenshots → Agent SDK
  rebuild → local preview.
- `server.ts` — the UI: one HTTP server, an inline HTML page, SSE progress. `tsx server.ts`.
- `serve.ts` — `next build` + `npx serve` for the finished clone, plus `stop`.

Your phase's plan file in `docs/plans/PHASE-<id>.md` is your spec. Read it fully before
touching code, and edit only the files it names.

## Ground rules

- **One phase per session.** Do your phase, run the gate, commit, stop. Do not start the
  next phase. Do not "also fix" something you noticed — note it in the commit message.
- **`bash scripts/gate.sh` must pass before you commit.** No exceptions. It runs
  `npx tsc --noEmit` and boots the UI on port 4999 for a smoke test.
- **NEVER start a long-running server or a clone job.** No `npm run ui`, no `tsx server.ts`
  left running, no `POST /api/clone` with a real URL, no `next build` of a client site. Real
  runs cost money and hit live client sites. The gate is the only server you start, and it
  kills itself. **Port 3999 is Ian's — never bind it.** Use 4999 (gate) or 4998 (anything
  ad hoc), and kill it before you finish.
- **Never touch `sites/`.** It holds real client runs — crawled markdown, screenshots,
  built clones. Read it if a phase needs to understand the layout; never write, move, or
  delete anything in it. It is gitignored and must stay out of every commit.
- **No new dependencies.** The entire dep list is `@anthropic-ai/claude-agent-sdk` and
  `tsx`, and it stays that way. Node's stdlib (`node:fs`, `node:http`, `node:crypto`,
  `node:child_process`, global `fetch`/`AbortController`) covers everything the plans ask
  for. Do not edit `package.json`.
- **Never touch `.env`** or print its contents.

## The SSE step-name contract (the easiest thing to break)

`server.ts:5-12` defines six canonical step names. `pipeline.ts` emits every log line
starting with the exact name of the step it belongs to, and the UI picks the active step
with `STEPS.findIndex(s => line.startsWith(s))` at `server.ts:165`.

```
Mapping pages · Extracting content · Capturing design ·
Rebuilding site · Verifying against original · Publishing local preview
```

So: any log line you add or change must keep its step's exact prefix, and you must not
rename, reorder, or add to `STEPS` unless your phase file explicitly says to. A line like
`Cost: $1.42` emitted mid-rebuild silently resets the UI's progress; `Rebuilding site —
$1.42 so far` is correct. New *event types* (`review`, `confirm`, `stop`) are fine — they
are separate SSE events and never reach the log matcher.

Related: `QA_MARKER` (`pipeline.ts:235`, emitted at `:380`, detected at `:432-438`) is how
the UI learns step 5 started. Keep it working.

## Commit

- Conventional commits, scoped to the file you changed:
  `fix(server): honour PORT env var, default 3999`,
  `feat(pipeline): review gate before rebuild`,
  `perf(pipeline): run QA subagent on sonnet, drop screenshot re-read`.
- Body: one line per plan item you completed, and a line for anything you could not do.
- Commit only source. `sites/`, `logs/`, `.done/`, `node_modules/`, `*.log` and `.env*` are
  gitignored — if `git status` shows any of them, stop and fix `.gitignore` rather than
  committing them.
- Push to `origin` on the current branch if a remote is configured.

## Commands

```bash
bash scripts/gate.sh     # the gate: tsc --noEmit + UI smoke test on 4999
npx tsc --noEmit         # typecheck alone, while iterating
```

`npm run ui` (port 3999) is **Ian's command, not yours.** He runs local QA after the build.
