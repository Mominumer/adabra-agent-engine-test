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

After `claim`, nobody needs to run `heartbeat` or `flush`. If a claim is lost the agent drops it and shows a desktop notification.

## Run the helper on Windows

Run these in PowerShell from the repo folder. You need Node 22.13 or newer on PATH. You do not need admin rights, and no
password is stored. **Not yet run on a real Windows machine**: if something misbehaves, the log and `status` are the place to start.

```powershell
node helper\cli.js enroll https://<coordinator-host> <device-id>
Get-Clipboard | Set-Content -NoNewline -Encoding ascii -LiteralPath "$HOME\.team-agent\token"   # copy the token first

powershell -NoProfile -ExecutionPolicy Bypass -File service\helper-service.ps1 install
powershell -NoProfile -ExecutionPolicy Bypass -File service\helper-service.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File service\helper-service.ps1 logs        # %LOCALAPPDATA%\Adabra\Logs\adabra-helper.log
powershell -NoProfile -ExecutionPolicy Bypass -File service\helper-service.ps1 uninstall
node helper\cli.js status                                                                   # outbox, claims held, and whether the agent is reporting
```

`-ExecutionPolicy Bypass` applies to that one command and changes no setting. `install` is safe to repeat; run it again after
moving the repo folder or Node. `uninstall` leaves your enrollment and the log in place.

- **Starts at logon, in your session.** The task `ai.adabra.helper` runs only while you are logged on, on battery too, with no
  time limit and no window. A lost claim shows a Windows notification, and is always in the log.
- **Comes back after a crash.** A supervisor restarts the agent after 10 seconds. If the supervisor itself dies, a trigger that
  fires every minute starts the task again; while the task is running that trigger does nothing.
- **What protects the token.** `chmod` and `umask` do nothing on Windows; the folder's access list does the job. Your profile
  folder already allows only you, SYSTEM and Administrators, and `install` sets the same on `TEAM_AGENT_HOME`, wherever it is.
  `status` warns if anyone else can open the folder or the token. As with root on macOS, an administrator can always read it.

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

## Review worker (Mac mini: dispatcher + Docker test sandbox)

Watches open PRs and puts two commit statuses on every new head commit: `adabra/tests` and `adabra/review`. Make both
required in branch protection and a failing or missing check blocks the merge; a new push is checked again.
`adabra/tests` runs `npm test` on the exact commit inside a throwaway Docker container (no network, no host files, no
secrets, not root, read-only system, 4 GB / 2 CPU / 512 processes / 15 min). `adabra/review` is the mock review skill
(`reviewer/review-mock.js`, reviewer `mock-v1`): it reads the PR's diff for that exact commit and fails on an added
`debugger;` line or `MOCK-REVIEW: fail` in the PR description. The real Claude review will replace only this step. See `REVIEW_WORKER_PLAN.md` in the plan folder.

```bash
umask 077; mkdir -p ~/.adabra; read -rs T; printf %s "$T" > ~/.adabra/review-token; unset T   # paste token, Enter
docker pull node:26-slim
node reviewer/main.js sandbox-check        # must print "sandbox is locked down" before any PR runs
REVIEW_AUTHORS=Mominumer REVIEW_IMAGE=$(docker image inspect node:26-slim --format '{{index .RepoDigests 0}}') \
  service/reviewer-service.sh install
service/reviewer-service.sh status
node reviewer/main.js retry <pr>          # run a PR's latest commit again
```

Only PRs from branches of this repo, by authors in `REVIEW_AUTHORS`, and not drafts, are run.

## Review results on tasks

When the reviewer finishes a PR that belongs to a task, the coordinator learns the result: the task's progress comment
shows `review passed`, `changes requested` with a summary of the findings, or `review could not complete`, and
`node helper/cli.js tasks` shows it too. A PR belongs to a task if its branch is exactly `task/TASK-7` or its description has a
line reading exactly `Task: TASK-7`. A PR that names two different tasks is linked to neither.

Text from a review is untrusted, because it can quote the code under review. The progress comment shows it only inside a
labelled code block, where Markdown, images, links and mentions do nothing. `tasks` is read by builder agents, so it never
carries that text at all: only the verdict, severity (one of a closed list), location (a path with no spaces, and a line) and
counts, with a note saying where the details are and what they are.

```
reviewer: statuses and PR comment posted -> result saved in reviewer.db with the job -> POST /v1/review-results (own timer, retried)
coordinator: stored durably, acks -> worker updates the task's ONE progress comment (retried)
```

The reviewer posts as its own enrolled device. Devices have a role, fixed when they are added: only a `reviewer` may post
results, and only a `builder` may claim tasks, write checkpoints or list tasks. The coordinator alone holds the GitHub token
that writes to the task's issue.

```bash
node coordinator/main.js device-add mini-reviewer reviewer     # prints the token once
umask 077; read -rs T; printf %s "$T" > ~/.adabra/reviewer-device-token; unset T   # paste token, Enter
REVIEW_DEVICE_ID=mini-reviewer REVIEW_COORDINATOR_URL=http://127.0.0.1:8787 REVIEW_AUTHORS=... REVIEW_IMAGE=... \
  service/reviewer-service.sh install
node reviewer/main.js status                                   # also lists results that are not delivered
```

Without `REVIEW_DEVICE_ID` the feature is off (the log says so) and reviews run exactly as before. Results wait in
`reviewer.db` for as long as the coordinator is away, or its token or role is wrong; they are dropped only when the
coordinator refuses them for good, such as for an unknown task. A result for an older commit never replaces one for a newer
commit, and a re-delivered result changes nothing.

A failed review **returns** the task to its owner. That is a reservation, not a claim: no lease or claim generation changes.
Others are refused (`a failed review returned it to member-a`), and the owner sees it first in `tasks` and claims it as usual,
which ends the reservation. The owner is the device the task is reserved for, else whoever holds the live lease, else whoever
claimed it last, even if they have released. A passing review also ends it. If the owner has gone away, revoking the device
ends it, as does `node coordinator/main.js task-assign TASK-7 <device-id|none>`.

## Review user containment (Mac mini, no model yet)

The real review will read untrusted PR text, so it runs as a separate macOS user that holds no GitHub token and cannot enter the
dispatcher's home folder. This part builds and proves that boundary. **A plain install cannot call Claude**: the wrapper's model
step is switched off, it never loads the credential, and it exits 78 if asked to review. `adabra/review` is still the mock unless
`REVIEW_ENGINE` says otherwise (below).

```
dispatcher (holds the review GitHub token)
  1. cleans the commit's tarball in a sandbox container: reviewer/clean-worker.cjs, no PR code runs
  2. unpacks only the clean result into /opt/adabra-review/in/<pr>-<sha>-<time>/ : tree/, diff.patch, pr.json, manifest.json
     owner dispatcher, group adabra-review, dirs 750, files 640, so the review user can read it and cannot change it
  3. sudo -n -u adabra-review /opt/adabra-review/bin/run-review <job-id>
wrapper (root-owned, as adabra-review): starts from an empty environment, accepts only a job id, refuses a job holding a link
```

The cleaning step keeps only regular text files. It drops symlinks, hardlinks, devices and fifos, paths that are absolute or use
`..`, names with control or invisible characters, agent config at any depth (`.claude/`, `CLAUDE.md`, `CLAUDE.local.md`,
`AGENTS.md`, `.mcp.json`, in any case), binaries, files over 1 MB and anything past 50 MB or 20,000 files. `manifest.json` lists
what was dropped. A change to a dropped file still shows as text in `diff.patch`.

```bash
sudo service/review-user.sh install        # root-owned wrapper and settings, the job root, one sudoers line; safe to re-run
node reviewer/main.js review-check         # must end with "review user is contained"; needs no sudo, token or database
sudo service/review-user.sh uninstall      # removes them; keeps the user, its login and the CLI
sudo service/review-user.sh install --enable-model   # also turns the model step on: reviews can then spend. A plain install turns it off
```

The wrapper and its settings are copies owned by root, so a merged PR changes nothing here until the installer runs again.
`review-check` probes from the review user's side: tokens and databases `denied`, Docker `refused`, a job readable but not
writable, only allowed environment variables. A canary file and the Docker socket are its positive controls: the dispatcher can
reach both, so the review user's refusal means something. Its probes open and close files without reading them, and it never
prints a file's contents.

`review-check` cannot spend, with the model step on or off. To start the model the wrapper needs both the root-owned
`etc/model-enabled` (absent: exit 78) and a `paid-run` mark in the job directory (absent: exit 79). Only the dispatcher's paid path
writes that mark; the jobs `review-check` builds never hold it, and a PR's files all go under `tree/`, where the mark does not count.

## The real review's output handling

```
REVIEW_ENGINE=mock     (default) the mock decides. No job directory, no sudo, nothing paid
REVIEW_ENGINE=shadow   the mock decides; the real review also runs and posts only a verdict to adabra/review-shadow, not required.
                       Its findings stay in the local log
REVIEW_ENGINE=claude   the real review decides adabra/review
REVIEW_DAILY_CAP=30    real review runs per UTC day, counted before each one starts, retries included
```

Before anything is spent: if the tests did not pass, `adabra/review` is `error` ("Skipped: tests failed"). Checks that need no model
can only block: an added `debugger;`, hidden Unicode, a changed file GitHub will not show (unless it is an image or font, or
`REVIEW_UNSHOWN_OK` lists its extension), a diff of 100 files or 256 KB. The PR's head is compared with the commit just before the
run. A valid result is stored by PR, commit, skill and model, so a retry after GitHub failed, or a restart, does not pay again.

What comes back is untrusted, so the dispatcher checks it itself: the result's type, subtype and `is_error` together, its own check
against `reviewer/review-user/review-schema.json`, the commit, the verdict against the findings, every file against the job, and an
empty list of denied tool calls. Anything else is `error`; nothing but a fully valid `pass` is `success`. Status text is fixed
strings or counts, so the model's words never reach a status, and the CLI's own text goes only to the local log. Findings go in the
PR comment inside a code block, where no link, image or HTML can take effect, followed by a list of paths to read yourself. The
review is advisory: a pass means the reviewer raised no blocker, not that the change is safe.

| Failure | `adabra/review` | What happens next |
|---|---|---|
| Account limit, or 402/429 | `error`: paused | All real reviews wait until the stated reset, or 1 h doubling to 6 h. One job probes when it ends. Uses no attempts |
| Not logged in, bad credential, 401/403, model step off | `error`: operator action needed | All real reviews wait for `retry <pr>` or a restart. Uses no attempts |
| Daily cap | `error`: daily limit | Until 00:00 UTC. Uses no attempts |
| 5xx, network | `error` | Backs off, at most 3 attempts on a commit, then final |
| Turn, budget or time limit; invalid output | `error`, final | No automatic retry. `retry <pr>` runs it again |
| Anything unrecognised | `error` | Retried like the row above, and three in a row open the same pause as an account limit |

While reviews are paused the tests still run and `adabra/tests` still posts its real result. A pause is kept in `reviewer.db` across
restarts, except the one waiting for the operator, which a restart lifts. `node reviewer/main.js status` shows the pause and the
day's count.

## Not built yet (by design)

Claim/lease validation (`claim_generation` is carried but not checked), cancellation, review workers, context
delivery, Slack. See the blueprint milestones M3-M7.
