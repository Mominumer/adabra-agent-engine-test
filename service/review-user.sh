#!/bin/bash
# Installs what the separate review user runs: a root-owned wrapper with its settings, the job directory root, and one sudoers
# line. Run it with sudo, as the user who runs the review dispatcher.
#
#   sudo service/review-user.sh install     install or update (safe to re-run); a PR changes nothing until this runs
#   sudo service/review-user.sh uninstall   remove them and the sudoers line; keeps the user, its login and the CLI
#
# Needs first: the review user, with its own primary group and not an admin; both home folders at mode 700; a root-owned CLI at
# /opt/adabra-review/bin/claude. Afterwards, without sudo: node reviewer/main.js review-check
#
# What the sudoers line allows: the dispatcher's user may run /opt/adabra-review/bin/run-review as the review user, with no
# password. Nothing else, and privilege only ever goes down.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

RU=adabra-review
OPT=/opt/adabra-review
SUDOERS=/etc/sudoers.d/adabra-review
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_DIR/reviewer/review-user"

die() { printf 'STOPPED: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ok: %s\n' "$*"; }
home_of() { dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | awk '{print $2}'; }
safe_path() { [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ ]]; }

CMD="${1:-}"
case "$CMD" in
  install | uninstall) ;;
  *) echo "usage: sudo $0 install | uninstall"; exit 2 ;;
esac
[ "$(id -u)" = 0 ] || die "run this with sudo: sudo $0 $CMD"
[ "$(uname)" = Darwin ] || die "this is for macOS"

if [ "$CMD" = uninstall ]; then
  rm -f "$SUDOERS"
  rm -rf "$OPT/in" "$OPT/etc" "$OPT/skill"
  rm -f "$OPT/bin/run-review"
  echo "removed the sudoers line, wrapper, settings and job directories"
  echo "kept: the $RU user, its home and login, and $OPT/bin/claude"
  exit 0
fi

OWNER="${SUDO_USER:-}"
[[ "$OWNER" =~ ^[a-z_][a-z0-9_-]*$ ]] && [ "$OWNER" != root ] && [ "$OWNER" != "$RU" ] \
  || die "run this with sudo from the account that runs the review dispatcher, not as root directly"

echo "== Checking what must already be in place"
id "$RU" >/dev/null 2>&1 || die "there is no $RU user yet"
if dseditgroup -o checkmember -m "$RU" admin >/dev/null 2>&1; then die "$RU is an admin; it must be a standard user"; fi
[ "$(id -gn "$RU")" = "$RU" ] || die "$RU must have its own primary group"
OWNER_HOME="$(home_of "$OWNER")"
RU_HOME="$(home_of "$RU")"
safe_path "$OWNER_HOME" && safe_path "$RU_HOME" || die "could not read the home folders of $OWNER and $RU"
[ "$(stat -f %Lp "$OWNER_HOME")" = 700 ] || die "$OWNER_HOME must be mode 700 before the review user can be trusted near it"
[ "$(stat -f %Lp "$RU_HOME")" = 700 ] || die "$RU_HOME must be mode 700"
[ -x "$OPT/bin/claude" ] && [ "$(stat -f %Su "$OPT/bin/claude")" = root ] || die "$OPT/bin/claude must exist and be owned by root"
for f in run-review settings.json review-schema.json review-v1.md; do
  [ -f "$SRC/$f" ] || die "missing $SRC/$f"
done
# Where the services' databases are, so the check probes the real ones even when this runs from another checkout.
SERVICE_DIR="$(plutil -extract WorkingDirectory raw "$OWNER_HOME/Library/LaunchAgents/ai.adabra.reviewer.plist" 2>/dev/null || echo "$REPO_DIR")"
safe_path "$SERVICE_DIR" || die "the services' folder has characters this script does not accept: $SERVICE_DIR"
ok "$RU is a standard user with its own group; both homes are 700; the CLI is root-owned"

echo "== Installing root-owned files in $OPT"
install -d -o root -g wheel -m 755 "$OPT" "$OPT/bin" "$OPT/etc" "$OPT/skill"
install -o root -g wheel -m 755 "$SRC/run-review" "$OPT/bin/run-review"
install -o root -g wheel -m 644 "$SRC/settings.json" "$OPT/etc/settings.json"
install -o root -g wheel -m 644 "$SRC/review-schema.json" "$OPT/etc/review-schema.json"
install -o root -g wheel -m 644 "$SRC/review-v1.md" "$OPT/skill/review-v1.md"
PATHS_TMP="$(mktemp "$OPT/etc/.paths.XXXXXX")"
cat > "$PATHS_TMP" <<EOF
REVIEW_USER=$RU
REVIEW_HOME=$RU_HOME
DISPATCHER_HOME=$OWNER_HOME
SERVICE_DIR=$SERVICE_DIR
EOF
chown root:wheel "$PATHS_TMP"
chmod 644 "$PATHS_TMP"
mv -f "$PATHS_TMP" "$OPT/etc/paths.sh"
ok "wrapper, settings, schema, skill and paths"

# Owned by the dispatcher, group of the review user: new jobs inherit the group, so the review user can read them and cannot
# change them, and the dispatcher's user does not have to join any group.
install -d -m 750 "$OPT/in"
chown "$OWNER:$RU" "$OPT/in"
chmod 750 "$OPT/in"
ok "$OPT/in is $OWNER:$RU, mode 750"

echo "== Installing the sudoers line"
SUDOERS_TMP="$(mktemp /tmp/adabra-review-sudoers.XXXXXX)"
trap 'rm -f "$SUDOERS_TMP"' EXIT
cat > "$SUDOERS_TMP" <<EOF
# Installed by service/review-user.sh. The review dispatcher may start the wrapper as the review user, and nothing else.
Defaults!$OPT/bin/run-review command_timeout=15m
$OWNER ALL=($RU) NOPASSWD: $OPT/bin/run-review
EOF
visudo -cf "$SUDOERS_TMP" >/dev/null || die "the sudoers line did not validate, so nothing was installed"
install -o root -g wheel -m 440 "$SUDOERS_TMP" "$SUDOERS"
if ! visudo -c >/dev/null 2>&1; then
  rm -f "$SUDOERS"
  die "sudo's configuration did not validate with the new line, so it was removed"
fi
if ! sudo -l -U "$OWNER" 2>/dev/null | grep -Fq "$OPT/bin/run-review"; then
  rm -f "$SUDOERS"
  die "sudo did not pick up $SUDOERS. Does /etc/sudoers include /etc/sudoers.d? The line was removed"
fi
ok "$OWNER may run $OPT/bin/run-review as $RU, and nothing else was added"

echo "== Starting the wrapper once as $RU"
cd /
sudo -n -u "$RU" "$OPT/bin/run-review" check >/dev/null || die "the wrapper did not run as $RU"
ok "it runs"

echo
echo "Done. Now run this without sudo, from $REPO_DIR:"
echo "  node reviewer/main.js review-check"
