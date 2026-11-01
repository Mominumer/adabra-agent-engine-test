#!/bin/bash
# Run the helper background agent as a macOS LaunchAgent (starts at login, restarts if it crashes).
# It keeps held task leases alive and delivers queued checkpoints, so nobody runs heartbeat/flush by hand.
# Enroll first: node helper/cli.js enroll <url> <device-id>, then save the device token to ~/.team-agent/token.
#
#   service/helper-service.sh install     write the plist and start it
#   service/helper-service.sh status      is it running, and what did the last pass do
#   service/helper-service.sh logs        follow the log
#   service/helper-service.sh uninstall   stop it and remove the plist
set -euo pipefail

LABEL="ai.adabra.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/adabra-helper.log"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"
HOME_DIR="${TEAM_AGENT_HOME:-$HOME/.team-agent}"

case "${1:-}" in
  install)
    NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
    [ -f "$HOME_DIR/config.json" ] && [ -f "$HOME_DIR/token" ] || {
      echo "not enrolled: run node helper/cli.js enroll first and save the token to $HOME_DIR/token"; exit 1; }
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO_DIR/helper/agent.js</string></array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TEAM_AGENT_HOME</key><string>$HOME_DIR</string>
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
    sleep 3
    "$0" status
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =|last exit code" || true
    else
      echo "service not loaded"
    fi
    if [ -f "$HOME_DIR/agent-status.json" ]; then cat "$HOME_DIR/agent-status.json"; else echo "no agent-status.json yet"; fi
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
