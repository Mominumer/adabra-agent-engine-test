# adabra-agent-engine-test

Throwaway Milestone 2 test of the Adabra agent engine: one checkpoint from a laptop is stored durably by the
coordinator (Mac mini) and shown once on a GitHub test issue.

```
helper/cli.js checkpoint -> local SQLite outbox -> HTTPS over the tailnet -> coordinator stores it, acks
                                                                          -> worker updates ONE comment on the task's issue
```

No npm dependencies. Needs Node >= 22.13 (uses `node:sqlite`).

## Test

```bash
npm test
```

Covers: normal path; duplicate event; same id with different payload (409); unknown/revoked device, wrong token;
device impersonation, bad schema, unknown task; coordinator unreachable then delivered; GitHub down then applied once;
older event never regresses a newer one.

## Run on the Mac mini (coordinator)

```bash
# 1. once: register a device and a task (the token is printed once)
node coordinator/main.js device-add member-a
node coordinator/main.js task-add TASK-1 1            # TASK-1 -> issue #1

# 2. save a fine-grained GitHub token (this repo only, Issues: read/write) to a file only you can read
umask 077; mkdir -p ~/.adabra && pbpaste > ~/.adabra/github-token   # copy the token in your browser first

# 3. start (dry-run first: logs comments instead of posting)
GITHUB_DRY_RUN=1 node coordinator/main.js serve
GITHUB_REPO=Mominumer/adabra-agent-engine-test GITHUB_TOKEN_FILE=$HOME/.adabra/github-token node coordinator/main.js serve

# 4. expose it on the tailnet only (HTTPS 443 -> localhost:8787)
tailscale serve --bg 8787
```

The coordinator listens on 127.0.0.1 only; `tailscale serve` is the only way in.

## Run the coordinator as a service (Mac mini)

```bash
service/coordinator-service.sh install     # LaunchAgent: starts at login, restarts after a crash
service/coordinator-service.sh status
service/coordinator-service.sh logs        # ~/Library/Logs/adabra-coordinator.log
service/coordinator-service.sh uninstall
```

Stop any coordinator running in a Terminal window first (port 8787). The mini must log in automatically after a reboot
(System Settings > Users & Groups > Automatic login), because a LaunchAgent runs in the user's session.

## Run on a laptop (helper)

```bash
node helper/cli.js enroll https://jbrs-mac-mini.tail1aa763.ts.net member-a
umask 077; pbpaste > ~/.team-agent/token              # the token printed by device-add
node helper/cli.js checkpoint --task TASK-1 --summary "Payment screen implemented" \
  --verification "8 passed, 1 failed" --next "Fix failed payment handling"
node helper/cli.js status                              # outbox counts
```

## Run the helper in the background (laptops, and the mini as a builder)

```bash
service/helper-service.sh install     # LaunchAgent: renews held leases and delivers queued checkpoints every 30 s
service/helper-service.sh status
node helper/cli.js status             # outbox, claims held, and whether the agent is reporting
service/helper-service.sh uninstall
```

After `claim`, nobody needs to run `heartbeat` or `flush`. If a claim is lost the agent drops it and shows a macOS notification.
Windows laptops need an equivalent (Task Scheduler); not built yet.

## Assigning work

Tasks come from GitHub issues. Label an issue `agent-task` and the coordinator creates `TASK-<issue number>` within a minute
(it also runs `node coordinator/main.js task-sync` on demand). Add a label `assign:<device-id>` to reserve it for that
enrolled device; without one, anyone can claim it. Closing the issue or removing the label closes the task. Tasks added by
hand with `task-add` are never changed by the sync; use `task-assign <TASK-1> <device-id|none>` for those.

```bash
node coordinator/main.js tasks               # mini: every task, who it is reserved for, who holds it
node helper/cli.js tasks                      # laptop: what you can work on (reserved for you first)
node helper/cli.js claim-next                 # claim the first available one
```

A reserved task refuses everyone else's claim (`reserved for member-b`); a closed task refuses all claims.

## Review worker (Mac mini, phase 1: dispatcher)

Watches open PRs and puts two commit statuses on every new head commit: `adabra/tests` and `adabra/review`. Make both
required in branch protection and a failing or missing check blocks the merge; a new push is checked again.
Phase 1 has no sandbox yet, so both checks report `error` (never a pass). See `REVIEW_WORKER_PLAN.md` in the plan folder.

```bash
umask 077; mkdir -p ~/.adabra; read -rs T; printf %s "$T" > ~/.adabra/review-token; unset T   # paste token, Enter
REVIEW_AUTHORS=Mominumer service/reviewer-service.sh install
service/reviewer-service.sh status
node reviewer/main.js retry <pr>          # run a PR's latest commit again
```

Only PRs from branches of this repo, by authors in `REVIEW_AUTHORS`, and not drafts, are run.

## Not built yet (by design)

Claim/lease validation (`claim_generation` is carried but not checked), cancellation, review workers, context
delivery, Slack. See the blueprint milestones M3-M7.
