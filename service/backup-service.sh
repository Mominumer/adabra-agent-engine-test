#!/bin/bash
# Back up the coordinator and reviewer databases every night, as a macOS LaunchAgent.
#
#   service/backup-service.sh install     write the plist and load it (loading also runs a first backup)
#   service/backup-service.sh status      is it loaded, and how did the last run go
#   service/backup-service.sh run         start a backup now, in the service
#   service/backup-service.sh drill       prove the newest backups restore, on a temp copy
#   service/backup-service.sh logs        follow the log
#   service/backup-service.sh uninstall   stop it and remove the plist; the backups stay
#
# Settings (override by exporting before `install`, and when running status or drill by hand):
#   COORDINATOR_DB        default <repo>/coordinator.db
#   REVIEW_DB             default <repo>/reviewer.db
#   ADABRA_BACKUP_DIR     default ~/adabra-backups
#   ADABRA_BACKUP_STATUS  default ~/Library/Logs/adabra-backup-status.json
set -euo pipefail

LABEL="ai.adabra.backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/adabra-backup.log"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
    COORDINATOR_DB="${COORDINATOR_DB:-$REPO_DIR/coordinator.db}"
    REVIEW_DB="${REVIEW_DB:-$REPO_DIR/reviewer.db}"
    ADABRA_BACKUP_DIR="${ADABRA_BACKUP_DIR:-$HOME/adabra-backups}"
    ADABRA_BACKUP_STATUS="${ADABRA_BACKUP_STATUS:-$HOME/Library/Logs/adabra-backup-status.json}"
    # Only whether the files exist. A wrong path here would fail every night, so say so now.
    for db in "$COORDINATOR_DB" "$REVIEW_DB"; do
      [ -f "$db" ] || { echo "no database at $db: install from the running checkout, or set COORDINATOR_DB and REVIEW_DB"; exit 1; }
    done
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO_DIR/backup/main.js</string><string>run</string><string>--notify</string></array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COORDINATOR_DB</key><string>$COORDINATOR_DB</string>
    <key>REVIEW_DB</key><string>$REVIEW_DB</string>
    <key>ADABRA_BACKUP_DIR</key><string>$ADABRA_BACKUP_DIR</string>
    <key>ADABRA_BACKUP_STATUS</key><string>$ADABRA_BACKUP_STATUS</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>15</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>Umask</key><integer>63</integer>
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
    # RunAtLoad has started the first backup. No kickstart -k here: that would kill a run in progress.
    sleep 2
    "$0" status || true
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|runs =|last exit code" || true
    else
      echo "service not loaded"
    fi
    node "$REPO_DIR/backup/main.js" status
    ;;
  run)
    # Without -k: if a backup is already running, this leaves it alone.
    launchctl kickstart "$DOMAIN/$LABEL"
    echo "started; see: $0 status"
    ;;
  drill)
    shift
    node "$REPO_DIR/backup/main.js" drill "$@"
    ;;
  logs)
    tail -f "$LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL; the backups stay where they are"
    ;;
  *)
    echo "usage: $0 install | status | run | drill [--file <backup>] | logs | uninstall"; exit 2
    ;;
esac
