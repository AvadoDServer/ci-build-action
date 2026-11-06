#!/usr/bin/env bash
# Start test: runs the package's docker-compose.yml from the image the build
# just made, waits SMOKE_SECONDS, and fails when a container crashed, keeps
# restarting or exited with an error. It cannot tell whether a node syncs; it
# catches what a new upstream version most often breaks: a removed flag, a
# changed config file or entrypoint, a missing library.
set -uo pipefail

COMPOSE=${SMOKE_COMPOSE:-docker-compose.yml}
WAIT=${SMOKE_SECONDS:-90}
P=avadosmoke
summary() { echo "$*" >> "$GITHUB_STEP_SUMMARY"; }

if [ ! -f "$COMPOSE" ]; then
  echo "No $COMPOSE here, nothing to start."; exit 0
fi

# Networks a box has and the package expects (dncore_network and the like).
docker compose -f "$COMPOSE" config --format json 2>/dev/null |
  jq -r '.networks // {} | to_entries[] | select(.value.external == true) | .value.name // .key' |
  while read -r net; do docker network create "$net" >/dev/null 2>&1 || true; done

if ! docker compose -p "$P" -f "$COMPOSE" up -d 2>&1; then
  summary "### Start test: FAILED, the package did not start"
  docker compose -p "$P" -f "$COMPOSE" logs --no-color --tail 100 || true
  exit 1
fi

echo "Started; watching it for ${WAIT}s."
sleep "$WAIT"

bad=0
summary "### Start test (${WAIT}s)"
summary "| container | state | restarts | exit code | health |"
summary "|---|---|---|---|---|"
for id in $(docker compose -p "$P" -f "$COMPOSE" ps -aq); do
  read -r name state restarts code health < <(docker inspect -f \
    '{{.Name}} {{.State.Status}} {{.RestartCount}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$id")
  name=${name#/}
  verdict=ok
  if [ "$state" = "running" ] && [ "$restarts" = "0" ]; then :
  elif [ "$state" = "exited" ] && [ "$code" = "0" ] && [ "$restarts" = "0" ]; then :   # a one-shot helper that finished
  else verdict=FAILED; bad=1
  fi
  [ "$health" = "unhealthy" ] && echo "::warning::$name reports unhealthy (not counted: a health check may need the box's network)"
  summary "| $name | $state | $restarts | $code | $health |"
  echo "$name: $state, restarts $restarts, exit $code, health $health -> $verdict"
  if [ "$verdict" = FAILED ]; then
    echo "::group::Last log lines of $name"; docker logs --tail 100 "$id" 2>&1; echo "::endgroup::"
  fi
done

docker compose -p "$P" -f "$COMPOSE" down -v --timeout 20 >/dev/null 2>&1 || true
if [ "$bad" = 1 ]; then
  summary "**FAILED**: a container crashed or keeps restarting (logs in the step output)."
  exit 1
fi
summary "**Passed**"
