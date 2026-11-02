#!/bin/bash
# Run the review dispatcher as a macOS LaunchAgent (starts at login, restarts if it crashes).
#
#   service/reviewer-service.sh install     write the plist and start it
#   service/reviewer-service.sh status      is it running, and what is in the queue
#   service/reviewer-service.sh logs        follow the log
#   service/reviewer-service.sh uninstall   stop it and remove the plist
#
# Settings (override by exporting before `install`):
#   GITHUB_REPO         default Mominumer/adabra-agent-engine-test
#   REVIEW_TOKEN_FILE   default ~/.adabra/review-token (the reviewer's own token, not the coordinator's)
#   REVIEW_APP_ID, REVIEW_APP_INSTALLATION_ID, REVIEW_APP_KEY_FILE
#                       use a GitHub App instead of the token file (see the README): all three, or none.
#                       They are checked with GitHub before the running service is touched.
#   REVIEW_AUTHORS      required: comma-separated GitHub logins whose PRs may run on the mini
#   REVIEW_DB           default <repo>/reviewer.db
#   REVIEW_IMAGE        default node:26-slim (pull it first; pin by digest)
#   REVIEW_TEST_CMD     default npm test
#   REVIEW_DEVICE_ID    this reviewer's enrolled device, role reviewer. Unset: tasks are not told review results
#   REVIEW_DEVICE_TOKEN_FILE  default ~/.adabra/reviewer-device-token (that device's token, not a GitHub token)
#   REVIEW_COORDINATOR_URL    e.g. http://127.0.0.1:8787
set -euo pipefail

LABEL="ai.adabra.reviewer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/adabra-reviewer.log"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
    GITHUB_REPO="${GITHUB_REPO:-Mominumer/adabra-agent-engine-test}"
    REVIEW_APP_ID="${REVIEW_APP_ID:-}"
    REVIEW_APP_INSTALLATION_ID="${REVIEW_APP_INSTALLATION_ID:-}"
    REVIEW_APP_KEY_FILE="${REVIEW_APP_KEY_FILE:-}"
    REVIEW_DB="${REVIEW_DB:-$REPO_DIR/reviewer.db}"
    REVIEW_IMAGE="${REVIEW_IMAGE:-node:26-slim}"
    REVIEW_TEST_CMD="${REVIEW_TEST_CMD:-npm test}"
    REVIEW_DEVICE_ID="${REVIEW_DEVICE_ID:-}"
    REVIEW_DEVICE_TOKEN_FILE="${REVIEW_DEVICE_TOKEN_FILE:-$HOME/.adabra/reviewer-device-token}"
    REVIEW_COORDINATOR_URL="${REVIEW_COORDINATOR_URL:-}"
    [ -n "${REVIEW_AUTHORS:-}" ] || { echo "set REVIEW_AUTHORS, e.g. REVIEW_AUTHORS=alice,bob $0 install"; exit 1; }
    if [ -n "$REVIEW_APP_ID$REVIEW_APP_INSTALLATION_ID$REVIEW_APP_KEY_FILE" ]; then
      (cd "$REPO_DIR" && GITHUB_REPO="$GITHUB_REPO" REVIEW_APP_ID="$REVIEW_APP_ID" REVIEW_APP_INSTALLATION_ID="$REVIEW_APP_INSTALLATION_ID" \
        REVIEW_APP_KEY_FILE="$REVIEW_APP_KEY_FILE" "$NODE" reviewer/main.js github-check) || { echo "GitHub App settings did not pass; the running service was not touched"; exit 1; }
      AUTH_ENV="    <key>REVIEW_APP_ID</key><string>$REVIEW_APP_ID</string>
    <key>REVIEW_APP_INSTALLATION_ID</key><string>$REVIEW_APP_INSTALLATION_ID</string>
    <key>REVIEW_APP_KEY_FILE</key><string>$REVIEW_APP_KEY_FILE</string>"
    else
      REVIEW_TOKEN_FILE="${REVIEW_TOKEN_FILE:-$HOME/.adabra/review-token}"
      [ -f "$REVIEW_TOKEN_FILE" ] || { echo "missing review token file: $REVIEW_TOKEN_FILE"; exit 1; }
      AUTH_ENV="    <key>REVIEW_TOKEN_FILE</key><string>$REVIEW_TOKEN_FILE</string>"
    fi
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO_DIR/reviewer/main.js</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GITHUB_REPO</key><string>$GITHUB_REPO</string>
$AUTH_ENV
    <key>REVIEW_AUTHORS</key><string>$REVIEW_AUTHORS</string>
    <key>REVIEW_DB</key><string>$REVIEW_DB</string>
    <key>REVIEW_IMAGE</key><string>$REVIEW_IMAGE</string>
    <key>REVIEW_TEST_CMD</key><string>$REVIEW_TEST_CMD</string>
    <key>REVIEW_DEVICE_ID</key><string>$REVIEW_DEVICE_ID</string>
    <key>REVIEW_DEVICE_TOKEN_FILE</key><string>$REVIEW_DEVICE_TOKEN_FILE</string>
    <key>REVIEW_COORDINATOR_URL</key><string>$REVIEW_COORDINATOR_URL</string>
    <key>PATH</key><string>$HOME/.docker/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF
    chmod 600 "$PLIST"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout returns before the old service is gone; bootstrapping too early fails and leaves nothing loaded
    for _ in $(seq 1 20); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
    for _ in 1 2 3 4 5; do launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && break; sleep 1; done
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { echo "could not load $LABEL (see: launchctl bootstrap $DOMAIN $PLIST)"; exit 1; }
    launchctl kickstart -k "$DOMAIN/$LABEL"
    sleep 2
    "$0" status
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =|last exit code" || true
    else
      echo "service not loaded"
    fi
    (cd "$REPO_DIR" && REVIEW_DB="${REVIEW_DB:-$REPO_DIR/reviewer.db}" node reviewer/main.js status) || true
    echo; echo "log: $LOG"
    ;;
  logs)
    tail -f "$LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    ;;
  *)
    echo "usage: $0 install | status | logs | uninstall"; exit 2
    ;;
esac
