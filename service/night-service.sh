#!/bin/bash
# Run the overnight runner as a macOS LaunchAgent. A LaunchAgent and not a LaunchDaemon: Docker Desktop and its socket exist only in this
# user's login session, so with nobody logged in nothing runs, which fails closed. It restarts if it crashes, and sweeps up on every start.
#
#   service/night-service.sh install     check the settings, then write the plist and start it. It refuses unless main requires your review
#   service/night-service.sh status      is it running, and what the runner says
#   service/night-service.sh logs        follow the log, which holds fixed words and IDs only
#   service/night-service.sh uninstall   stop it and remove the plist. The records, the ledger and the reports stay
#
# Settings: see night/settings.js for each one. Exported before `install`, and written into the plist. The plist holds file paths and IDs,
# and no secret.
#   Required: GITHUB_REPO, NIGHT_APPROVER_ID, NIGHT_AUTHOR_IDS, NIGHT_APPROVAL_LABEL_ID, NIGHT_APP_ID, NIGHT_APP_INSTALLATION_ID,
#             NIGHT_APP_KEY_FILE, NIGHT_IMAGE_ID, NIGHT_REQUIRED_REVIEW_ON=yes (your word that main requires your review)
# The others have the defaults below. The runner refuses any stop file but /opt/adabra-control/stop.json, and refuses to start if it is missing.
set -euo pipefail

LABEL="ai.adabra.night"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/adabra-night.log"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

# The same defaults for every command, so status looks where the service runs.
NIGHT_STOP_FILE="${NIGHT_STOP_FILE:-/opt/adabra-control/stop.json}"
NIGHT_HOME="${NIGHT_HOME:-$HOME/.adabra/night/state}"
NIGHT_DB="${NIGHT_DB:-$HOME/.adabra/night/ledger.db}"
TEAM_AGENT_HOME="${TEAM_AGENT_HOME:-$HOME/.adabra/night/helper}"
NIGHT_CREDENTIAL_FILE="${NIGHT_CREDENTIAL_FILE:-$HOME/.adabra/night/model-credential}"
NIGHT_IMAGE="${NIGHT_IMAGE:-adabra-night:dev}"
NIGHT_TUNNEL_NETWORK="${NIGHT_TUNNEL_NETWORK:-bridge}"
NIGHT_RUNS_PER_NIGHT="${NIGHT_RUNS_PER_NIGHT:-1}"
NIGHT_REPORT_DIR="${NIGHT_REPORT_DIR:-$HOME/Library/Logs/adabra-night}"
export NIGHT_STOP_FILE NIGHT_HOME NIGHT_DB TEAM_AGENT_HOME NIGHT_CREDENTIAL_FILE NIGHT_IMAGE NIGHT_TUNNEL_NETWORK NIGHT_RUNS_PER_NIGHT NIGHT_REPORT_DIR
export PATH="$PATH:$HOME/.docker/bin:/opt/homebrew/bin:/usr/local/bin"

case "${1:-}" in
  install)
    NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
    (cd "$REPO_DIR" && "$NODE" night/main.js serve --check) || { echo "the settings did not pass; the running service was not touched"; exit 1; }
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    # A long throttle: with a setting gone bad it restarts, refuses and says why, once a minute, and nothing runs.
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO_DIR/night/main.js</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GITHUB_REPO</key><string>$GITHUB_REPO</string>
    <key>NIGHT_APPROVER_ID</key><string>$NIGHT_APPROVER_ID</string>
    <key>NIGHT_AUTHOR_IDS</key><string>$NIGHT_AUTHOR_IDS</string>
    <key>NIGHT_APPROVAL_LABEL_ID</key><string>$NIGHT_APPROVAL_LABEL_ID</string>
    <key>NIGHT_DB</key><string>$NIGHT_DB</string>
    <key>NIGHT_STOP_FILE</key><string>$NIGHT_STOP_FILE</string>
    <key>NIGHT_HOME</key><string>$NIGHT_HOME</string>
    <key>TEAM_AGENT_HOME</key><string>$TEAM_AGENT_HOME</string>
    <key>NIGHT_APP_ID</key><string>$NIGHT_APP_ID</string>
    <key>NIGHT_APP_INSTALLATION_ID</key><string>$NIGHT_APP_INSTALLATION_ID</string>
    <key>NIGHT_APP_KEY_FILE</key><string>$NIGHT_APP_KEY_FILE</string>
    <key>NIGHT_CREDENTIAL_FILE</key><string>$NIGHT_CREDENTIAL_FILE</string>
    <key>NIGHT_IMAGE</key><string>$NIGHT_IMAGE</string>
    <key>NIGHT_IMAGE_ID</key><string>$NIGHT_IMAGE_ID</string>
    <key>NIGHT_TUNNEL_NETWORK</key><string>$NIGHT_TUNNEL_NETWORK</string>
    <key>NIGHT_RUNS_PER_NIGHT</key><string>$NIGHT_RUNS_PER_NIGHT</string>
    <key>NIGHT_REPORT_DIR</key><string>$NIGHT_REPORT_DIR</string>
    <key>NIGHT_REQUIRED_REVIEW_ON</key><string>$NIGHT_REQUIRED_REVIEW_ON</string>
    <key>PATH</key><string>$HOME/.docker/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
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
    sleep 2
    "$0" status
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =|last exit code" || true
    else
      echo "service not loaded"
    fi
    (cd "$REPO_DIR" && node night/main.js status) || true
    echo; echo "log: $LOG"
    ;;
  logs)
    tail -f "$LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL; the records, the ledger and the reports stay where they are"
    ;;
  *)
    echo "usage: $0 install | status | logs | uninstall"; exit 2
    ;;
esac
