#!/bin/bash
# Set up this Mac as a builder: checks what it needs, enrols it, saves the token, installs the background helper and runs a
# first test. Safe to run again. onboarding/GUIDE.md explains it; your operator gives you the values.
#
#   onboarding/setup-mac.sh --coordinator <address> --device <device-id> --test-task <TASK-N>
#
# Run with --help for the options. This only makes sure Node can run onboarding/setup.js, which does the work.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_FIX="Install it from https://nodejs.org/en/download, open a new terminal, and run this again."

if ! command -v node >/dev/null 2>&1; then
  echo "Node was not found: this needs Node 22.13 or newer. $NODE_FIX" >&2
  exit 1
fi
# </dev/null, so nothing here can read a token piped to this script.
VERSION="$(node -p 'process.versions.node' </dev/null)" || {
  echo "Node is installed, but it did not run: this needs Node 22.13 or newer. $NODE_FIX" >&2
  exit 1
}
MAJOR="${VERSION%%.*}"
REST="${VERSION#*.}"
MINOR="${REST%%.*}"
if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 13 ]; }; then
  echo "Node $VERSION is too old: this needs Node 22.13 or newer. $NODE_FIX" >&2
  exit 1
fi
if [ ! -f "$REPO_DIR/helper/cli.js" ] || [ ! -f "$REPO_DIR/onboarding/setup.js" ]; then
  echo "The repository was not found around this script. Run git clone with the address from your operator, then run this script from the new folder." >&2
  exit 1
fi

exec node "$REPO_DIR/onboarding/setup.js" "$@"
