# Phase 3.2 — Scaffold in code, not prose

**Why now:** `orchestratorPrompt` Phase 2 (`pipeline.ts:410-420`) spells out the entire
contents of `package.json`, `next.config.ts`, `postcss.config.mjs` and `tsconfig.json` —
and then pays Opus to retype them, every run, in a file nobody will ever read twice. The
prompt already knows the answer; typing it is not a judgement call. Write the files from
plain code and delete the instructions.

## Goal

1. `pipeline.ts` writes `app/package.json`, `app/next.config.ts`, `app/postcss.config.mjs`
   and `app/tsconfig.json` before the agent session starts.
2. The orchestrator prompt's Phase 2 says the scaffold already exists, names the files, and
   forbids recreating or editing them.
3. Everything that actually depends on the crawled site — `globals.css` with the `@theme`
   block, the fonts, `layout.tsx`, the components — stays with the agent.

## Files / anchors to touch

### `pipeline.ts` — the scaffold writer

- New function `scaffold(siteDir: string, onLog: (l: string) => void)` placed near
  `rebuild` (`pipeline.ts:460`). Called from `rebuild` immediately after the
  `mkdirSync(path.join(siteDir, 'app'))` at `pipeline.ts:468` and before the
  `Rebuilding site — …` line at `:469`, or from `runClone` just before the `rebuild` call
  at `pipeline.ts:682`. Inside `rebuild` is preferred — it keeps "everything the agent
  session needs" in one place.
- Files and contents, verbatim from what the prompt currently dictates:
  - `app/package.json` — `{ name: 'clone', private: true, version: '0.1.0' }`, scripts
    `dev` / `build` / `start` (`next dev` / `next build` / `next start`), dependencies
    `next@^15`, `react@^19`, `react-dom@^19`, devDependencies `typescript`,
    `@types/react`, `@types/node`, `tailwindcss@^4`, `@tailwindcss/postcss`. Exactly the
    list at `pipeline.ts:412-413` — do not add or drop a package.
  - `app/next.config.ts` — `export default { output: 'export', images: { unoptimized: true } }`
    (`pipeline.ts:414`). Keep `output: 'export'`: the whole downstream export-completeness
    check (`missingExportRoutes`, `pipeline.ts:563-575`) and `serve.ts`'s `npx serve out`
    (`serve.ts:139`) depend on it.
  - `app/postcss.config.mjs` — `export default { plugins: { '@tailwindcss/postcss': {} } }`
    (`pipeline.ts:415`).
  - `app/tsconfig.json` — standard Next 15 app-router config: `strict`, `jsx: 'preserve'`,
    `moduleResolution: 'bundler'`, `paths: { '@/*': ['./src/*'] }`, the
    `{ name: 'next' }` plugin, `include` covering `next-env.d.ts`, `**/*.ts`, `**/*.tsx`
    and `.next/types/**/*.ts`, `exclude: ['node_modules']` (`pipeline.ts:416`).
- **Overwrite rules** (get these right or a re-run will eat the agent's work):
  - `next.config.ts`, `postcss.config.mjs`, `tsconfig.json` — overwrite unconditionally.
    They are pure boilerplate; nothing the agent does to them is worth keeping.
  - `package.json` — write **only if it does not already exist**. `npm install` rewrites
    that file, so on a re-run it may legitimately carry a dependency the agent added and a
    lockfile that matches it. Clobbering it would desync `app/node_modules`. Log which
    branch was taken.
- Emit one log line, e.g. `Rebuilding site — scaffolded app/ (package.json, next.config.ts,
  postcss.config.mjs, tsconfig.json)`. Keep the `Rebuilding site` prefix (see contract
  below).
- Use `node:fs` only. `JSON.stringify(obj, null, 2)` for the two JSON files; plain template
  strings for the two `.ts`/`.mjs` files. No template directory, no file copying from a
  `templates/` folder — inline constants next to the function are simpler and this is the
  only consumer.

### `pipeline.ts` — the prompt

- Replace the Phase 2 block (`pipeline.ts:410-420`) with a short statement that the
  scaffold already exists:
  - list the four files as already written, and say **do not recreate, edit or reformat
    them** — in particular `next.config.ts` must keep `output: 'export'`;
  - keep the `src/app/globals.css` bullet (`pipeline.ts:417-418`) exactly as it is — the
    `@import "tailwindcss";` + `@theme` block + extracted `@keyframes` are token-derived
    and stay the agent's job;
  - keep the `next/font/google` bullet (`pipeline.ts:419`);
  - keep `Run npm install in app/` (`pipeline.ts:420`). Installing is deliberately still
    the agent's step — see "Do not" below;
  - keep the "do NOT run create-next-app; it is interactive and slow" warning
    (`pipeline.ts:411`).
- Leave Phase 1 (`pipeline.ts:394-408`), Phase 3 (`:422-427`), Phase 4 (`:429-442`),
  Phase 5 (`:444-448`) and Phase 6 (`:450-455`) untouched.

## SSE prefix contract

`STEPS` (`server.ts:5-12`) and the matcher at `server.ts:366` are unchanged. The scaffold
runs inside step 4, so its log line must start with the exact string `Rebuilding site` —
`Scaffolding app/…` silently resets the UI's active step. Do not rename, reorder or add to
`STEPS`, and keep `QA_MARKER` (`pipeline.ts:308`, emitted at `:451`, detected at
`:525-530`) working.

## Acceptance criteria

- Calling `scaffold()` against an empty throwaway directory under `/tmp` writes exactly
  four files; both JSON files `JSON.parse` cleanly and both module files are valid ES
  module syntax.
- Called twice, the three boilerplate files are rewritten and an existing `package.json` is
  left byte-identical.
- `orchestratorPrompt` no longer contains the literal contents of any of the four files,
  and does contain an instruction not to recreate them.
- `output: 'export'` survives, so `missingExportRoutes` and `serve.ts` still work.
- `npx tsc --noEmit` exits 0 and `bash scripts/gate.sh` passes.

## Do not

- No new dependencies. `node:fs` writes files; there is nothing else to do here. Do not add
  a templating library, and do not edit the repo's own `package.json` (the *clone's*
  `app/package.json` is a generated artifact, which is a different thing).
- Do not have `pipeline.ts` run `npm install` for the agent. That is a multi-minute network
  operation with its own failure modes, and the phase's value is in deleting prompt tokens,
  not in moving a shell command. Note it as a possible follow-up in the commit message.
- Do not scaffold `globals.css`, `layout.tsx`, `page.tsx` or any component — those depend
  on `source/design-tokens.md` and are the agent's actual work.
- Do not create `app/` anywhere but under `siteDir`, and do not touch `sites/` by hand —
  test against a directory in `/tmp`.
- Do not change the six step names or break the step-name prefix convention.
- Do not run `npm install`, `next build`, a preview server, or a real clone run to test
  this. Writing and re-reading the files is the whole test.
