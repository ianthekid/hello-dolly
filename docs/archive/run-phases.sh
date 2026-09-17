#!/usr/bin/env bash
# Headless driver: runs PLAN_V1 Phases 1–4 unattended, one claude session per phase.
# Resume-safe (.done/ stamps). Stops the line if a phase fails both model tiers.
set -u
cd "$(dirname "$0")"

PLANS=docs/plans
TIMEOUT=7200       # kill a ballooning session; a timeout counts as a failed attempt
LIMIT_RE='hit your (session|weekly|opus) limit|usage limit reached'
LIMIT_SLEEP=1800   # parsing "resets 3:45pm" across timezones isn't worth it — a still-
                   # limited retry errors out instantly and we sleep again
mkdir -p .done logs

# Two tiers only: sonnet, then opus. No third rung.
escalate() { [ "$1" = sonnet ] && echo opus; }

gate() { bash scripts/gate.sh; }

revert() {
  # THIS repo is the git repo — there is no nested app/ checkout. Discard uncommitted
  # work only; a committed-but-broken phase needs a manual `git reset --hard HEAD~1`.
  #
  # `git clean -fd` WITHOUT -x: sites/, logs/, .done/, node_modules/ and *.log are all
  # gitignored, so they are never touched. Do not add -x — it would delete every client
  # run under sites/ and the driver's own logs and stamps.
  git checkout -- . 2>/dev/null
  git clean -fd -e sites -e logs -e .done -e node_modules 2>/dev/null
}

phase() { # phase <id> <model>
  local id=$1 model=$2 m
  local prompt="Read $PLANS/PHASE-$id.md and execute it."
  [ -f ".done/$id" ] && { echo "=== Phase $id already done, skipping"; return 0; }
  for m in "$model" $(escalate "$model"); do
    while :; do
      echo "=== Phase $id ($m) — $(date)"
      timeout "$TIMEOUT" claude -p "$prompt" --model "$m" --dangerously-skip-permissions \
        > "logs/$id-$m.log" 2>&1
      if grep -qiE "$LIMIT_RE" "logs/$id-$m.log"; then
        # Subscription window exhausted — not a phase failure. Discard partial work,
        # wait out the window, retry the same phase on the SAME tier.
        echo "=== Usage limit hit — sleeping $((LIMIT_SLEEP/60))m, then retrying phase $id ($(date))"
        revert
        sleep "$LIMIT_SLEEP"
        continue
      fi
      break
    done
    if gate; then touch ".done/$id"; echo "=== Phase $id PASSED on $m"; return 0; fi
    echo "=== Phase $id failed gate on $m — reverting (log: logs/$id-$m.log)"
    revert
  done
  echo "=== Phase $id FAILED both tiers. Stopping the line."
  exit 1
}

# PLAN_V1 Phase 1 — reliability, logging, then the cheap token wins.
phase 1.1 sonnet   # port env override + clean typecheck baseline (unblocks the gate)
phase 1.2 sonnet   # per-run log file + live cost
phase 1.3 sonnet   # invalidatable pages.json cache
phase 1.4 sonnet   # export completeness check + serve.ts spawn hygiene
phase 1.5 sonnet   # token wins

# PLAN_V1 Phase 2 — the gates. Bigger blast radius, but still sonnet-first: starting a
# phase on opus would spend its only attempt there, and one gate failure would stop the
# line for the night. Sonnet-first keeps the opus escalation in reserve.
phase 2.1 sonnet   # review gate before the rebuild (SSE review event + approve + replay)
phase 2.2 sonnet   # stop button, force-unwedge, pre-QA cost checkpoint

# PLAN_V1 Phase 3 — the big token win, then ops polish.
phase 3.1 sonnet   # screenshot tiling at capture (adds sharp — the one permitted new dep)
phase 3.2 sonnet   # scaffold the Next.js config files in code, not in the prompt
phase 3.3 sonnet   # previews list + stop, duplicate "done" lines, live cost, Firecrawl retry

# PLAN_V1 Phase 4 — hosted mode. Code only: HOSTED=1 skips the npx-serve spawn and links
# nginx's /preview/<domain>/ instead. The nginx/ufw/systemd half is docs/HOSTED.md, which
# Ian applies on the droplet by hand — no phase executes it.
phase 4.1 sonnet   # hosted mode switch: basePath at generation, no per-preview server

echo "=== ALL PHASES DONE — $(date)"
