#!/usr/bin/env bash
# The gate: typecheck + a smoke test of the UI server.
# Safe to run repeatedly; never leaves a process behind (trap + kill).
# Exit 0 = phase may be committed. Anything else = revert.
set -u
cd "$(dirname "$0")/.."

PORT="${GATE_PORT:-4999}"     # never 3999 — that port is Ian's
BOOT_TIMEOUT=30               # seconds to wait for the server to answer
LOG=".gate-server.log"
PID=""

cleanup() {
  local code=$?
  if [ -n "$PID" ]; then
    # tsx may fork; take the children first, then the leader, then the group.
    pkill -P "$PID" 2>/dev/null
    kill "$PID" 2>/dev/null
    sleep 1
    pkill -9 -P "$PID" 2>/dev/null
    kill -9 "$PID" 2>/dev/null
    kill -9 -- "-$PID" 2>/dev/null
  fi
  # Belt and braces: anything still holding the throwaway port is ours.
  if command -v lsof >/dev/null 2>&1; then
    local stray
    stray=$(lsof -ti tcp:"$PORT" 2>/dev/null)
    [ -n "$stray" ] && kill -9 $stray 2>/dev/null
  fi
  rm -f "$LOG"
  exit $code
}
trap cleanup EXIT INT TERM

fail() { echo "GATE FAIL: $*" >&2; exit 1; }

# ------------------------------------------------------------------ typecheck
echo "--- gate: npx tsc --noEmit"
npx --yes tsc --noEmit || fail "typecheck"

# ----------------------------------------------------------------- smoke test
# Start the UI on a throwaway port. PORT support lands in Phase 1.1; before that
# this step fails, which is correct — 1.1 is the phase that fixes it.
echo "--- gate: booting tsx server.ts on port $PORT"
PORT="$PORT" npx tsx server.ts > "$LOG" 2>&1 &
PID=$!

up=0
for _ in $(seq 1 "$BOOT_TIMEOUT"); do
  kill -0 "$PID" 2>/dev/null || break   # died on boot
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then up=1; break; fi
  sleep 1
done
if [ "$up" != 1 ]; then
  echo "--- server log ---" >&2; cat "$LOG" >&2
  fail "server did not answer on port $PORT within ${BOOT_TIMEOUT}s (is PORT honoured? see PHASE-1.1)"
fi

# 1. GET / must be 200
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[ "$code" = "200" ] || fail "GET / returned $code, expected 200"

# 2. POST /api/clone with a malformed body must 4xx and must NOT kill the process.
#    NOTE: never POST a real, valid URL here — that starts a paid clone run.
for body in 'not json at all' '{}' '{"url":123}' '{"url":"ftp://nope"}' '{"url":""}'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -d "$body" \
    "http://127.0.0.1:$PORT/api/clone")
  case "$code" in
    4*) ;;
    *) fail "POST /api/clone with body [$body] returned $code, expected 4xx" ;;
  esac
  kill -0 "$PID" 2>/dev/null || { echo "--- server log ---" >&2; cat "$LOG" >&2; \
    fail "server died on body [$body]"; }
done

# 3. Unknown routes 404 rather than hanging.
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/clone/nope/events")
[ "$code" = "404" ] || fail "GET unknown job events returned $code, expected 404"

# 4. Still alive and still serving after all of that.
kill -0 "$PID" 2>/dev/null || fail "server not running at end of smoke test"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[ "$code" = "200" ] || fail "GET / returned $code after smoke test, expected 200"

echo "GATE PASS"
exit 0
