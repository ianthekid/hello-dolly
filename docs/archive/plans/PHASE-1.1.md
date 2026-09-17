# Phase 1.1 — Configurable port + a clean typecheck baseline

**Why first:** every later phase is graded by `scripts/gate.sh`, and the gate boots the UI
server on a throwaway port so it never collides with Ian's 3999. Today the port is a
hardcoded constant, so the gate cannot run. Nothing else can land until this does.

## Goal

1. `server.ts` listens on `process.env.PORT` when set, `3999` otherwise.
2. `npx tsc --noEmit` exits 0 on the repo as it stands.

## Files / anchors to touch

- `server.ts:4` — `const PORT = 3999;`
  Replace with an env-aware constant, e.g.
  `const PORT = Number(process.env.PORT) || 3999;`
- `server.ts:188` — `new URL(req.url || '/', \`http://localhost:${PORT}\`)`
  Already interpolates `PORT`; confirm it still reads the new constant (no change expected).
- `server.ts:258-260` — `server.listen(PORT, …)` and the startup `console.log`.
  The log line must print the **actual** port, so `ssh -L` tunnels and the gate can both
  see where it landed.
- `tsconfig.json` — only if `tsc` reports errors that are genuinely config problems
  (see below). Do not loosen `strict`.

## Typecheck baseline

Run `npx tsc --noEmit`. Two known hazards:

- `tsconfig.json` sets `"types": ["node"]`, but `@types/node` is **not** a dependency in
  `package.json`. If tsc cannot resolve node types, that is an environment gap, not a code
  bug — the VPS provisioning step installs `typescript` and `@types/node` as devDeps
  (see `SETUP.md`). Do **not** "fix" it by editing `package.json` or deleting the `types`
  entry; report it and stop.
- Any *real* pre-existing type error in `pipeline.ts` / `serve.ts` / `server.ts` is yours to
  fix in this phase, minimally and without changing runtime behaviour. Prefer narrowing and
  explicit types over `any` where it is a one-liner; leave the existing deliberate `any`s
  (Firecrawl JSON, SDK message blocks) alone.

## Acceptance criteria

- `PORT=4999 npx tsx server.ts` serves the UI on 4999; with `PORT` unset it serves on 3999.
- `curl -s -o /dev/null -w '%{http_code}' http://localhost:4999/` prints `200`.
- `npx tsc --noEmit` exits 0.
- `bash scripts/gate.sh` passes.

## Do not

- Do not add dependencies. Node's built-in `process.env` is all this needs.
- Do not change the six step names in `server.ts:5-12` (`STEPS`). The UI matches progress
  with `line.startsWith(step)` at `server.ts:165` — that prefix convention is a hard
  contract between `pipeline.ts` log lines and the UI. Every phase inherits this rule.
- Do not touch `sites/`, `.env`, or `package.json`.
- Do not start a clone job, and never bind 3999 yourself while testing — use 4999.
