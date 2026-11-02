#!/bin/bash
# The operator's emergency controls, run at the Mac mini from any folder. Fills in the same defaults the services use.
#
#   service/ops.sh stop --reason "..."           stop everything, until resume. Works with any service down. Agents may run it.
#   service/ops.sh resume                        undo it. Typed confirmation at a terminal. Agents must not run it.
#   service/ops.sh status                        what is in force, and why
#   service/ops.sh check                         exit 0 = go; any other exit = do not start anything. For the overnight runner.
#   service/ops.sh override <pr> --reason "..."  mark adabra/review as passed on the PR's current head commit. Typed confirmation
#                                                at a terminal. Agents must not run it, the same as merging.
#
# Settings for override (override by exporting first):
#   GITHUB_REPO         default Mominumer/adabra-agent-engine-test
#   REVIEW_TOKEN_FILE   default ~/.adabra/review-token
#   REVIEW_APP_ID, REVIEW_APP_INSTALLATION_ID, REVIEW_APP_KEY_FILE
#                       default what the reviewer service was installed with, so this posts as the service does. If any is
#                       exported, none is taken from the service.
#   REVIEW_DB           default <repo>/reviewer.db
#   REVIEW_LOG_FILE     default ~/Library/Logs/adabra-reviewer.log
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

case "${1:-}" in
  stop|resume|status|check)
    exec node ops/main.js "$@"
    ;;
  override)
    export GITHUB_REPO="${GITHUB_REPO:-Mominumer/adabra-agent-engine-test}"
    export REVIEW_DB="${REVIEW_DB:-$REPO_DIR/reviewer.db}"
    # These live in the service's plist, not in this shell. Without this, an override after a switch to the app would post with
    # the personal token while there is one, and fail in the emergency once it has been retired.
    PLIST="$HOME/Library/LaunchAgents/ai.adabra.reviewer.plist"
    if [ -z "${REVIEW_APP_ID:-}${REVIEW_APP_INSTALLATION_ID:-}${REVIEW_APP_KEY_FILE:-}" ] && [ -f "$PLIST" ]; then
      for name in REVIEW_APP_ID REVIEW_APP_INSTALLATION_ID REVIEW_APP_KEY_FILE; do
        value="$(sed -n "s#.*<key>$name</key><string>\(.*\)</string>.*#\1#p" "$PLIST")"
        [ -z "$value" ] || export "$name=$value"
      done
    fi
    exec node reviewer/main.js "$@"
    ;;
  *)
    echo "usage: $0 stop [--reason \"...\"] | resume | status | check | override <pr> --reason \"...\""; exit 2
    ;;
esac
