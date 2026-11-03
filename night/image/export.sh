#!/bin/sh
# The session's work, as one text diff on stdout and nothing else. The runner starts this with docker exec once the CLI has ended.
# Whatever the session left in .git only affects this container. What comes out is hostile text either way: the runner caps it and
# validates it before anything on the host touches it.
set -eu
cd /work
export HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
GIT='/usr/bin/git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null -c core.excludesFile=/dev/null'
$GIT add -A -- .
$GIT rm -r -q --cached --ignore-unmatch -- .task
exec $GIT diff --cached --no-ext-diff --no-textconv --no-renames --no-color
