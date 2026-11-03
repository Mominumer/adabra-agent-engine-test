#!/bin/sh
# What a session container runs: unpack the task, start the shim, run the CLI once, then hold the container so the runner can export
# the work. It is in the image, so a pull request cannot change the session that wrote it.
#
# Stdin is one tar archive from the runner holding TASK.md and source.tar.gz. The host unpacks nothing: the source tarball is opened
# here, inside the container.
set -eu

# The longest a finished session waits to be exported. The runner kills it long before this.
HOLD_SECONDS=3600

mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR" /tmp/in /work/.task
tar -xf - -C /tmp/in --no-same-owner
tar -xzf /tmp/in/source.tar.gz --strip-components=1 --no-same-owner -C /work
mv /tmp/in/TASK.md /work/.task/TASK.md
rm -rf /tmp/in

cd /work
git init -q -b main
printf '.task/\n' >>.git/info/exclude
git add -A
git -c user.name=adabra-night -c user.email=night@invalid -c commit.gpgsign=false commit -q --allow-empty -m base

node /opt/adabra-night/shim.cjs &
tries=0
while [ ! -e /tmp/.adabra-shim-ready ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ]; then
    echo 'entry: the shim did not start' >&2
    exit 70
  fi
  sleep 0.1
done

code=0
/opt/adabra-night/bin/claude -p \
  --restricted \
  --tools "Bash,Read,Edit,Write,Grep,Glob" \
  --disallowedTools "mcp__*" --strict-mcp-config \
  --disable-slash-commands \
  --permission-mode dontAsk --permission-prompts none \
  --system-prompt-file /opt/adabra-night/night-v1.md \
  --model claude-sonnet-5-5 \
  --max-turns 80 --max-budget-usd 5 \
  --no-session-persistence \
  --output-format stream-json --verbose \
  "Do the task in .task/TASK.md, in this directory. Leave your changes uncommitted." \
  </dev/null || code=$?
echo "entry: cli exited $code" >&2
exec sleep "$HOLD_SECONDS"
