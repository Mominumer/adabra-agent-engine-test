#!/bin/bash
# Run the coordinator as a macOS LaunchAgent (starts at login, restarts if it crashes).
#
#   service/coordinator-service.sh install     write the plist and start it
#   service/coordinator-service.sh status      is it running, and does /healthz answer
#   service/coordinator-service.sh logs        follow the log
#   service/coordinator-service.sh uninstall   stop it and remove the plist
#
# Settings (override by exporting before `install`):
#   GITHUB_REPO         default Mominumer/adabra-agent-engine-test
#   GITHUB_TOKEN_FILE   default ~/.adabra/github-token
#   GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_KEY_FILE
#                       use a GitHub App instead of the token file (see the README): all three, or none.
#                       They are checked with GitHub before the running service is touched.
#   COORDINATOR_DB      default <repo>/coordinator.db
set -euo pipefail

LABEL="ai.adabra.coordinator"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/adabra-coordinator.log"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
    GITHUB_REPO="${GITHUB_REPO:-Mominumer/adabra-agent-engine-test}"
    COORDINATOR_DB="${COORDINATOR_DB:-$REPO_DIR/coordinator.db}"
    GITHUB_APP_ID="${GITHUB_APP_ID:-}"
    GITHUB_APP_INSTALLATION_ID="${GITHUB_APP_INSTALLATION_ID:-}"
    GITHUB_APP_KEY_FILE="${GITHUB_APP_KEY_FILE:-}"
    if [ -n "$GITHUB_APP_ID$GITHUB_APP_INSTALLATION_ID$GITHUB_APP_KEY_FILE" ]; then
      (cd "$REPO_DIR" && GITHUB_REPO="$GITHUB_REPO" GITHUB_APP_ID="$GITHUB_APP_ID" GITHUB_APP_INSTALLATION_ID="$GITHUB_APP_INSTALLATION_ID" \
        GITHUB_APP_KEY_FILE="$GITHUB_APP_KEY_FILE" "$NODE" coordinator/main.js github-check) || { echo "GitHub App settings did not pass; the running service was not touched"; exit 1; }
      AUTH_ENV="    <key>GITHUB_APP_ID</key><string>$GITHUB_APP_ID</string>
    <key>GITHUB_APP_INSTALLATION_ID</key><string>$GITHUB_APP_INSTALLATION_ID</string>
    <key>GITHUB_APP_KEY_FILE</key><string>$GITHUB_APP_KEY_FILE</string>"
    else
      GITHUB_TOKEN_FILE="${GITHUB_TOKEN_FILE:-$HOME/.adabra/github-token}"
      [ -f "$GITHUB_TOKEN_FILE" ] || { echo "missing GitHub token file: $GITHUB_TOKEN_FILE"; exit 1; }
      AUTH_ENV="    <key>GITHUB_TOKEN_FILE</key><string>$GITHUB_TOKEN_FILE</string>"
    fi
    if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1 && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "port 8787 is already in use (a coordinator in a Terminal window?). Stop it with Ctrl+C, then run install again."
      exit 1
    fi
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO_DIR/coordinator/main.js</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COORDINATOR_DB</key><string>$COORDINATOR_DB</string>
    <key>GITHUB_REPO</key><string>$GITHUB_REPO</string>
$AUTH_ENV
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
    echo -n "healthz: "; curl -fsS --max-time 3 http://127.0.0.1:8787/healthz || echo "no answer"
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
