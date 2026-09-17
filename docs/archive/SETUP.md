# SETUP — unattended PLAN_V1 build on a DigitalOcean droplet

The droplet runs PLAN_V1 Phases 1–2 headlessly via `run-phases.sh`. You remote in to
spot-check, not to babysit. Nothing lives there but the git checkout — destroy it when the
run is done.

## 1. Droplet

Ubuntu 24.04, 2 vCPU / 4 GB is plenty (no app build, no browser). ~$0.04/hr.

## 2. Provision (as root)

```bash
apt-get update && apt-get install -y git tmux curl lsof
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
ufw allow OpenSSH && ufw --force enable

# Non-root user — REQUIRED: claude refuses --dangerously-skip-permissions as root
adduser --disabled-password --gecos "" build
rsync -a ~/.ssh/ /home/build/.ssh/ && chown -R build:build /home/build/.ssh
```

`lsof` is not optional — `scripts/gate.sh` uses it to guarantee no stray process is left
holding the smoke-test port.

Everything below runs as `build`.

## 3. Deploy key

The repo is private and the phases push their commits, so the key needs **write**.

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
# GitHub → ianthekid/hello-dolly → Settings → Deploy keys → Add,
# with "Allow write access" CHECKED.
ssh-keyscan github.com >> ~/.ssh/known_hosts   # pre-accept so the clone doesn't prompt
```

Per-repo deploy key, not your account key — scoped to this repo, dies with the droplet.
No agent forwarding; it stops working the moment you disconnect.

## 4. Claude Code + auth

```bash
npm config set prefix ~/.npm-global && echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc && source ~/.bashrc
npm i -g @anthropic-ai/claude-code

claude setup-token   # paste the URL into your local browser (Pro/Max subscription auth)
echo 'export CLAUDE_CODE_OAUTH_TOKEN=<token it printed>' >> ~/.bashrc && source ~/.bashrc
```

Do **not** copy your laptop's `~/.claude/CLAUDE.md` over (it references the rtk hook). A
fresh `~/.claude` is correct — the repo's `CLAUDE.md` is the only context the agent needs.

## 5. Clone + install

Prereq, on your laptop: this directory isn't a git repo yet. `git init`, commit, and push to
`git@github.com:ianthekid/hello-dolly.git` before provisioning. Check `git status` first —
`.gitignore` should be keeping `sites/`, `.env`, `node_modules/` and `*.log` out.

```bash
git clone git@github.com:ianthekid/hello-dolly.git website-clone && cd website-clone
npm install
chmod +x run-phases.sh          # if git didn't carry the exec bit
```

**Two devDeps the gate needs that `package.json` does not declare.** `scripts/gate.sh` runs
`npx tsc --noEmit`, and `tsconfig.json` sets `"types": ["node"]`, but neither `typescript`
nor `@types/node` is a dependency. Install them on the droplet without committing the
change:

```bash
npm install --no-save typescript @types/node
```

(Phase files forbid the agents from editing `package.json`, so this stays a provisioning
step. If you'd rather make it permanent, add them as devDeps yourself and push before
starting the run.)

No `.env` is needed on the droplet — no phase makes a Firecrawl call or starts a clone job.
Do not copy your local `.env` up.

**Verify the baseline before starting the driver:**

```bash
bash scripts/gate.sh     # expect: GATE PASS
```

It will fail on the smoke test until Phase 1.1 lands (`server.ts` hardcodes port 3999 —
making it honour `PORT` is exactly what 1.1 does). A `tsc` failure, though, means a
pre-existing type error the driver would blame on every phase — fix or note it first.

## 6. Run

```bash
tmux new -s clone
./run-phases.sh 2>&1 | tee logs/driver.log
# ctrl-b d to detach; close your laptop
```

Seven phases, in order, one fresh `claude -p` session each:

| Phase | What |
|---|---|
| 1.1 | `PORT` env override + clean typecheck baseline |
| 1.2 | per-run `sites/<domain>/run.log` + live cost |
| 1.3 | invalidatable `pages.json` cache + force-recrawl |
| 1.4 | export completeness check + `serve.ts` spawn hygiene |
| 1.5 | token wins (QA→sonnet, `onlyMainContent`, tokens from disk, `maxTurns`) |
| 2.1 | review gate before the rebuild (SSE `review` + approve + replay) |
| 2.2 | stop button, `force` unwedge, pre-QA cost checkpoint |

Each phase: sonnet first, `bash scripts/gate.sh` as the gate, revert uncommitted work and
retry one tier up (opus) on failure, 2-hour timeout per session, stop the line if both
tiers fail. Resume-safe — completed phases are stamped in `.done/`, so re-running after a
fix skips them.

Where things live:

- `logs/driver.log` — the driver's own output (sleeps, passes, failures).
- `logs/<phase>-<model>.log` — one per session attempt.
- `.done/<phase>` — the stamp. Delete one to force a re-run.

All three are gitignored, as are `sites/`, `.env*` and `*.log`. Note that `*.log` also
excludes the existing `spike.log` from the initial commit — intentional; it's scratch
output, not source.

Revert safety: this repo **is** the git repo (no nested `app/`). `revert()` runs
`git checkout -- . && git clean -fd` — deliberately **without `-x`**, so gitignored paths
(`sites/`, `logs/`, `.done/`, `node_modules/`) are never touched.

## 7. Remote in

```bash
ssh build@<droplet>
tmux attach -t clone           # watch the driver
tail -f logs/<phase>-<model>.log
git log --oneline              # one commit per passed phase
```

Nothing to port-forward — the gate's server lives for a few seconds at a time.

## 8. Usage limits & overage protection

- There is **no headless way to query session/weekly usage %** on Pro/Max.
- **Overage is opt-in.** Before the run, check claude.ai → Settings → Billing and confirm
  extra-usage credits are NOT enabled. With them off, hitting the limit just blocks with
  `You've hit your session limit · resets 3:45pm` — zero charges.
- The driver detects that message, discards the partial phase, sleeps 30 min, and retries
  the same phase on the same tier — looping until the window resets. Limit hits never
  consume the escalation retry and never stop the line.

## 9. After the run — local QA (yours)

The gate is typecheck + an HTTP smoke test. It proves nothing crashed; it does not prove
the review gate renders or the stop button stops. So:

```bash
git pull
npm run ui        # localhost:3999
```

Then drive it by hand: start a clone, watch the step list track the SSE prefixes, hit the
review gate, approve a subset, hit Stop mid-run, refresh the browser mid-gate. Check
`sites/<domain>/run.log` afterwards. `npm run previews:stop` frees any preview port.

## 10. Known limits

- Revert only discards *uncommitted* work. If an agent commits broken code and then fails
  the gate, `git reset --hard HEAD~1` by hand before re-running.
- If a phase fails both tiers the driver exits. Read `logs/<phase>-*.log`, fix or re-plan,
  then re-run `./run-phases.sh` — it resumes at the failed phase.
- PLAN_V1 Phases 3 and 4 are **not** in the driver, by decision. Re-plan them after these
  land and a run is boring.
