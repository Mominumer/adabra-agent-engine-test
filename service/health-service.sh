#!/bin/bash
# Run the health report and rotate the logs every 15 minutes, as a macOS LaunchAgent.
#
#   service/health-service.sh install         write the plist and load it (loading also runs a first report)
#   service/health-service.sh status          is it loaded, and what the last run found. Exit 1 on a FAIL, or if the job has stopped running
#   service/health-service.sh run             start a run now, in the service
#   service/health-service.sh drill <check>   simulate one check failing: writes the status file and raises the notification, and
#                                             touches no real service. Exits 1, as a real failure does. `run` then shows the recovery.
#   service/health-service.sh logs            follow the log
#   service/health-service.sh uninstall       stop it and remove the plist; the status file and the logs stay
#
# Settings (override by exporting before `install`, and when running status or drill by hand):
#   REVIEW_DB             default <repo>/reviewer.db. Opened read-only
#   ADABRA_BACKUP_STATUS  default ~/Library/Logs/adabra-backup-status.json
#   ADABRA_STOP_FILE      default unset: each run finds the stop file as every service does. If set it goes in the plist, and wins
#   ADABRA_HEALTH_STATUS  default ~/.adabra-control/health-status.json
#   TEAM_AGENT_HOME       default ~/.team-agent. Only agent-status.json is read
#   COORDINATOR_PORT      default 8787
set -euo pipefail

LABEL="ai.adabra.health"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/adabra-health.log"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
    REVIEW_DB="${REVIEW_DB:-$REPO_DIR/reviewer.db}"
    ADABRA_BACKUP_STATUS="${ADABRA_BACKUP_STATUS:-$HOME/Library/Logs/adabra-backup-status.json}"
    STOP_ENV=""
    [ -z "${ADABRA_STOP_FILE:-}" ] || STOP_ENV="    <key>ADABRA_STOP_FILE</key><string>$ADABRA_STOP_FILE</string>"
    ADABRA_HEALTH_STATUS="${ADABRA_HEALTH_STATUS:-$HOME/.adabra-control/health-status.json}"
    TEAM_AGENT_HOME="${TEAM_AGENT_HOME:-$HOME/.team-agent}"
    COORDINATOR_PORT="${COORDINATOR_PORT:-8787}"
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    # launchd never starts a job that is still running, so one run cannot overlap the next. No KeepAlive: a job that ends has finished.
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO_DIR/ops/main.js</string><string>health</string><string>--job</string></array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REVIEW_DB</key><string>$REVIEW_DB</string>
    <key>ADABRA_BACKUP_STATUS</key><string>$ADABRA_BACKUP_STATUS</string>
$STOP_ENV
    <key>ADABRA_HEALTH_STATUS</key><string>$ADABRA_HEALTH_STATUS</string>
    <key>TEAM_AGENT_HOME</key><string>$TEAM_AGENT_HOME</string>
    <key>COORDINATOR_PORT</key><string>$COORDINATOR_PORT</string>
    <key>PATH</key><string>$HOME/.docker/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
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
    # RunAtLoad has started the first run. No kickstart -k here: that would kill a run in progress.
    sleep 5
    "$0" status || echo "(a line above says what is wrong, or the first run is still going: run status again in a minute)"
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|runs =|last exit code" || true
    else
      echo "service not loaded"
    fi
    echo "log: $LOG"
    node "$REPO_DIR/ops/main.js" health --last
    ;;
  run)
    # Without -k: if a run is already going, this leaves it alone.
    launchctl kickstart "$DOMAIN/$LABEL"
    echo "started; see: $0 status"
    ;;
  drill)
    [ -n "${2:-}" ] || { echo "usage: $0 drill <check>, for example: $0 drill docker"; exit 2; }
    echo "simulating a failure of the $2 check; no real service is touched. Exit 1 below is expected."
    exec "$REPO_DIR/service/ops.sh" health --job --simulate-fail "$2"
    ;;
  logs)
    tail -f "$LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL; the status file and the logs stay where they are"
    ;;
  *)
    echo "usage: $0 install | status | run | drill <check> | logs | uninstall"; exit 2
    ;;
esac
