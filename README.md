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
node helper/cli.js enroll https://<coordinator-host> member-a
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

## Onboarding a teammate

`onboarding/` is the kit: one command for the operator, one script each for a Mac and a Windows teammate, and a one-page guide
(`onboarding/GUIDE.md`) for someone who has never seen this project. **The Windows script has not been run on a real Windows machine.**

```bash
node onboarding/operator.js add <device-id> --coordinator https://<coordinator-host> --test-task <TASK-N>   # on the coordinator's machine
onboarding/setup-mac.sh --coordinator https://<coordinator-host> --device <device-id> --test-task <TASK-N>  # on the teammate's Mac
node onboarding/operator.js rotate <device-id>                                                              # a lost token; never prints it
node onboarding/operator.js revoke <device-id>                                                              # a device that leaves, or a throwaway test
```

`add` never shows the token: it writes it to a file only you can read, and prints what to do next. Use it rather than `device-add`
on a shared screen. The address and IDs are inputs, and the only secret is that file, which you send privately and then delete.

To try the script on a machine that already has a helper, add `--home <a new folder>`: the usual `~/.team-agent` and the `ai.adabra.helper`
service are then left alone, because a separate folder never installs the service. `--skip-service` skips it on its own.

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

## Database backups (Mac mini)

A LaunchAgent backs up `coordinator.db` and `reviewer.db` every night at 03:15 and keeps 14 days of them in `~/adabra-backups`.

```bash
service/backup-service.sh install     # run from the running checkout. Loading the job also takes a first backup
service/backup-service.sh status      # the last run: each file, size and check result. Exit 1 if anything is wrong
service/backup-service.sh run         # take one now, in the service
service/backup-service.sh drill       # prove the newest backups restore, on a temp copy
service/backup-service.sh logs        # ~/Library/Logs/adabra-backup.log
service/backup-service.sh uninstall   # stops the job; the backups stay
```

- **How a backup is taken.** With `backup()` from `node:sqlite`, which is SQLite's online backup. It needs Node 22.16 or newer and no other tool. It reads through SQLite on a read-only connection, so it includes what is still in the WAL, and the whole copy happens inside one read transaction, so it is one consistent moment even while the services write. A plain copy of the `.db` file would miss the WAL.
- **What counts as good.** Each copy starts under a temp name and gets its final name only after `PRAGMA integrity_check` passes and the tables that database should have are there, so a file with a final name has always passed. The check finds broken structure, not a changed value inside a row. A backup is one file, mode 600, in a folder of mode 700, named like `coordinator-20261103T031500Z.db`. It holds device token hashes and PR data, so treat it as you would the database.
- **When something fails.** A failed copy or check, or a missing database, replaces nothing and deletes nothing. It shows in the status file and in `status`, the log, the job's exit code, and a desktop notification. The other database is still backed up.
- **Retention.** Straight after a database's backup passes, its backups over 14 days old are removed. The newest always stays, however old it is, and a failed run removes nothing. Only files with exactly this job's names are ever removed: the manual `coordinator-YYYYMMDD-HHMM.db` backups and the `before-restore-*` folders below are yours to delete.
- **If the mini is asleep or off.** Asleep at 03:15: launchd runs the job when it wakes, once however many nights it missed. Off, or nobody logged in: LaunchAgents need the login session, so the job runs at the next login (`RunAtLoad`), which is why the mini must log in automatically. A reboot therefore also takes a backup.
- **One at a time.** launchd never starts a job that is still running, and a run started by hand exits with code 75 if one is under way. The lock goes away with the process, so a crash cannot block later backups. The job has its own label and does not depend on the other services, so it keeps running while they are stopped. It never writes to a live database. If nothing else has a database open, the read-only connection can leave an empty `-wal` and a `-shm` beside it. They are harmless, and the restore steps below move them.

### The status file

`~/Library/Logs/adabra-backup-status.json` (or `ADABRA_BACKUP_STATUS`), replaced whole at the end of each run. It holds names, sizes and check results, and no database content. A run that dies writes nothing, so check the age of `finished_at` as well as `ok`: `status` treats more than 26 hours as a problem.

```json
{
  "version": 1,
  "started_at": "2026-11-03T03:15:00.012Z",
  "finished_at": "2026-11-03T03:15:01.234Z",
  "ok": false,
  "backup_dir": "/Users/you/adabra-backups",
  "retention_days": 14,
  "databases": {
    "coordinator": {
      "ok": true, "file": "coordinator-20261103T031500Z.db", "size_bytes": 90112, "integrity": "ok", "error": null,
      "newest_good_file": "coordinator-20261103T031500Z.db", "newest_good_at": "2026-11-03T03:15:00.000Z",
      "kept": 15, "removed": 1, "retention_error": null
    },
    "reviewer": {
      "ok": false, "file": null, "size_bytes": null, "integrity": "not_checked", "error": "database file is missing",
      "newest_good_file": "reviewer-20261102T031500Z.db", "newest_good_at": "2026-11-02T03:15:00.000Z",
      "kept": 14, "removed": 0, "retention_error": null
    }
  }
}
```

`integrity` is `ok`, `failed` or `not_checked`. `file` and `size_bytes` are this run's backup, and null if it failed.

### The restore drill

`service/backup-service.sh drill` copies the newest backup of each database into a fresh temp folder, opens the copy as a service would, runs `PRAGMA integrity_check`, confirms the expected tables exist, prints table names and row counts and no row's contents, and deletes the copy. `--file <backup>` drills one chosen backup. It refuses anything that could be a live database (a live path, a link to one, a file in the live folder, a file with a `-wal` beside it) and a temp folder in or under a live database's folder. It exits 1 unless every check passes.

### Restoring a database

A restore puts one database back to the moment of its backup. **Everything that database learned since then is lost**, while the rest of the system still remembers it, so the steps afterwards matter as much as the copy. Code, branches, PRs, commit statuses and issue comments live on GitHub and are not touched. To restore both, stop the reviewer first, restore both, then start the coordinator first.

**The coordinator**, from the running checkout:

```bash
export COORDINATOR_DB="$PWD/coordinator.db"     # or the path you installed with
DB="$COORDINATOR_DB"; JOB="gui/$(id -u)/ai.adabra.coordinator"

# 1. Choose the backup and check it before touching anything. This takes the newest; set B to an older one if you need to.
B="$(ls -1 "$HOME"/adabra-backups/coordinator-*T*Z.db | tail -1)"
node backup/main.js drill --file "$B"           # must end with "drill passed"

# 2. Stop the service. It comes back if you only kill it, so unload it, and wait until it has gone.
launchctl bootout "$JOB"
while launchctl print "$JOB" >/dev/null 2>&1; do sleep 1; done
lsof "$DB"*                                     # must print nothing; if a backup is running, wait for it

# 3. Keep the current file with its -wal and -shm. After a crash the -wal holds real data.
KEEP="$HOME/adabra-backups/before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$KEEP"
for f in "$DB" "$DB-wal" "$DB-shm"; do [ ! -e "$f" ] || mv "$f" "$KEEP/"; done

# 4. Put the backup in place. Nothing else may be beside it: SQLite would apply an old -wal to the restored file and corrupt it.
cp "$B" "$DB" && chmod 600 "$DB"
ls "$DB"*                                       # must list only the one file

# 5. Before anything can connect, fence every claim the old file remembers, and put device changes right (see below).
node coordinator/main.js claims | awk '$4 != "unclaimed" && $4 != "cancelled" {print $1}' | xargs -n 1 node coordinator/main.js claim-cancel
node coordinator/main.js device-revoke <device-id>     # each device revoked since the backup

# 6. Start it and check.
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.adabra.coordinator.plist"
service/coordinator-service.sh status
node coordinator/main.js tasks
```

What an older coordinator database means, and what to do:

- **Devices: do this first, it is a security matter.** A device revoked since the backup **works again** until you revoke it again. A token rotated since: the old token works again and the new one does not, so run `device-rotate <id>` and put the new token on the device. A device enrolled since is unknown: `device-add <id> [role]`, and the same. The kept file shows what the devices were, for a person to read: `sqlite3 "$KEEP/coordinator.db" "SELECT device_id, revoked, role FROM devices"`. If you cannot tell what changed, rotate every token, then revoke again.
- **Claims and leases.** The old claims' leases have almost always expired by now. Every builder working on a task loses its claim: the helper's next renewal is refused, it drops the claim and shows `Lost TASK-n`. Its work is safe on its branch. It carries on after `node helper/cli.js claim TASK-n`.
- **Claim generations go back**, so a number may be given out twice. That alone is harmless, because a checkpoint must also match the device and the run id, and each claim has a new run id. But the owner recorded at the backup would match again, even if it was replaced later, so its old queued checkpoints would be accepted. Step 5's `claim-cancel` closes that. The cost is that anyone with a live lease claims again, and a failed-review return on those tasks ends.
- **Helper outboxes.** Checkpoints acknowledged since the backup are not sent again, so they are gone from the database, though the latest one's text stays in the issue comment. Checkpoints still queued are refused as stale and marked `rejected` for good (`node helper/cli.js status` counts them). After claiming again, send one new checkpoint.
- **Progress comments.** The comment is found again by its marker, so there is no second one. Events that were pending at the backup are applied again, so a comment may step back to older text until that new checkpoint arrives.
- **Tasks.** Tasks from labelled issues come back within a minute, with their title, reservation and closed state. Tasks added by hand since the backup are gone, as is a `task-assign` on a hand-added task: run `task-add` and `task-assign` again.
- **Review results.** The reviewer has marked results delivered since the backup as done and will not send them again, so a task can show an old verdict, and a failed-review return can be missing or out of date. For each open PR with a task, run `node reviewer/main.js retry <pr>` to review it again and send a new result. `node coordinator/main.js task-assign TASK-7 <device-id|none>` ends a return that should not be there. If you also restored the reviewer from the same night, skip the retry.

**The reviewer**, from the running checkout:

```bash
export REVIEW_DB="$PWD/reviewer.db"             # or the path you installed with
DB="$REVIEW_DB"; JOB="gui/$(id -u)/ai.adabra.reviewer"

B="$(ls -1 "$HOME"/adabra-backups/reviewer-*T*Z.db | tail -1)"
node backup/main.js drill --file "$B"           # must end with "drill passed"

launchctl bootout "$JOB"
while launchctl print "$JOB" >/dev/null 2>&1; do sleep 1; done
lsof "$DB"*                                     # must print nothing

KEEP="$HOME/adabra-backups/before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$KEEP"
for f in "$DB" "$DB-wal" "$DB-shm"; do [ ! -e "$f" ] || mv "$f" "$KEEP/"; done

cp "$B" "$DB" && chmod 600 "$DB"
ls "$DB"*                                       # must list only the one file

launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.adabra.reviewer.plist"
service/reviewer-service.sh status
```

What an older reviewer database means, and what to do:

- **The job queue.** The reviewer forgets every PR commit it has seen since the backup. Each open PR's head it no longer knows is queued again: both checks go back to `pending` on that commit and it is reviewed again, so **a green PR cannot be merged until that finishes**. Wait for it. A job that was running at the backup runs again. A job queued at the backup for an older commit may still run; it posts to that older commit only, and its result never replaces one for a newer commit.
- **Undelivered results.** Results waiting at the backup are sent again, and the coordinator ignores any it already has. Results made since the backup and not yet delivered are gone. An open PR gets a new one from its new review. A PR closed since gets none, so its task will not hear about that last review: the result is on the PR.
- **A second review can return a task again** if it requests changes, even if the owner has moved on. `node coordinator/main.js task-assign TASK-7 <device-id|none>` ends that.
- **PR comments** are found again by their marker, so there is no second one.

Afterwards, for either one: run `service/backup-service.sh run`, so the next restore starts from here. Delete the `before-restore-*` folder by hand once you are sure. It holds the same sensitive data as a backup, and retention never touches it.
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
can only block: an added debugger statement, hidden Unicode, a changed file GitHub will not show (unless it is an image or font, or
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

**With an emergency stop.** The dispatcher looks at the stop at the last moment before each paid run, so none starts during a stop. A
run that has already started cannot be ended from here, as it belongs to another user. It finishes, a valid result is stored and it
counts towards the daily cap, nothing about it is posted, and the job goes back to the queue. After `resume` the job uses the stored
result and pays nothing. A result that was not valid is not stored, so that one job pays again.

**With a GitHub App outage.** An `authOutage` from the diff, the tarball, the head check or posting holds the job and retries every 30
seconds. No run is started or counted because of it. A result already paid for is stored, so it is posted once GitHub answers again.

A stop, a pause and an outage hold don't use attempts, and none of them changes another's state: a job waits for whichever applies.

**`override` works whatever `REVIEW_ENGINE` is,** since that command never builds a review engine. It also works on a job that is
waiting out a pause, because an outage blocking a merge is what it is for. It takes that job out of the queue so its result cannot replace
the override, and `retry <pr>` brings it back. It still refuses a job that is running or about to run.

## Emergency stop and operator override (Mac mini)

```bash
service/ops.sh stop --reason "..."           # stop everything, until resume. Works with any service down.
service/ops.sh resume                        # undo it; asks you to type the word
service/ops.sh status                        # what is in force, and why
service/ops.sh override <pr> --reason "..."  # adabra/review passes on the PR's current head commit; asks you to type the words
```

**While stopped:**

| Part | What it does |
|---|---|
| Coordinator | Refuses claims, renewals, checkpoints and review results with `503 stopped` and the reason. Writes nothing to GitHub. Tasks are still listed, a claim can still be released, and the read-only task sync goes on. |
| Held leases | Kept alive by the coordinator itself, so a stop of any length costs nobody a claim and no other device can take the task on resume. Same owner, same generation. A lease that had lapsed before the stop stays lapsed. |
| Helpers | Tell their owner once, as for a lost claim, and keep their claims. `tasks` and `status` show the stop and its reason. Checkpoints wait in the outbox with no backoff and go in the first pass after resume. |
| Reviewer | Starts nothing and posts nothing, and does not poll. A queued review stays queued and shows `pending`. A running job's container is ended within seconds, nothing about that run is posted, and it goes back to the queue without using up an attempt. Once posting has begun it finishes, so a result is never half-posted. |
| Overnight runner | Must run `service/ops.sh check` before it starts anything and between steps: exit 0 = go; any other exit = do not start. It prints one line of JSON. From Node: `isStopped()` in `shared/stop.js`. |

**Where it lives.** `~/.adabra-control/stop.json` (or `ADABRA_STOP_FILE`, if you set it for the services too). It belongs to no service, so `stop` works with any of them down, and each one reads it for itself. It is on disk, so a stop survives restarts and reboots. The file and its folder are readable by other users, so never put a secret in a reason. Only a missing file and a well-formed "not stopped" mean running; anything else that cannot be read counts as stopped. `resume` repairs a damaged file. `/healthz` also says `"stopped": true`.

Run `resume` with the coordinator up: a lease that ran out while the coordinator was down is restored only if the coordinator comes back before the resume. `resume` warns you.

**What a stop does not do.** It does not end a builder session already running on someone's machine: the owner is told, and that session can no longer claim or report progress, but it runs until someone ends it. It does not block `git push` or anything else that goes straight to GitHub.

**Reasons are plain text.** One line, no controls, no working `@mentions`, no Markdown or HTML. An override's reason goes to the reviewer's log and never to GitHub; the status always reads `operator override`. A stop's reason goes to enrolled devices and never to GitHub.

**Override** acts on the head commit it showed you, looked up again after you confirm. It refuses a closed or merged PR, and refuses while a review of that commit is queued or running, because the result would replace it (a real review waiting out a pause is the exception: see above). It never touches `adabra/tests`, so a PR whose tests failed stays blocked. A new push loses it, because statuses belong to a commit. It leaves a record in `~/Library/Logs/adabra-reviewer.log` (or `REVIEW_LOG_FILE`) before it posts: if it cannot write there, it does not post. It works during a stop, because it is a person's deliberate act and no job is involved.

**Who may run what.** Agents may run `stop`, `status`, `check` and `health`: stopping is the safe direction, and `health` only looks. `resume` and `override` are for a person at the mini, like merging. Both need a terminal and a typed confirmation, and `.claude/settings.json` denies them. **That is a speed bump, not a boundary.** While builder sessions run as the same macOS user as the reviewer, an agent can fake a terminal, edit the state file or read the token or key. Deny rules only bind sessions that load this repo's settings. A hard boundary needs the planned separate builder user.

## Health report and log rotation (Mac mini)

```bash
service/ops.sh health                    # checks everything now and only looks. Agents may run it. Exit 1 on a FAIL
service/ops.sh health --last             # what the job found last, without checking anything again
service/health-service.sh install        # run from the running checkout. Every 15 minutes, and once when it loads
service/health-service.sh status         # is it loaded, and the last run. Exit 1 on a FAIL, or if it has stopped running
service/health-service.sh run            # a run now, in the service
service/health-service.sh drill docker   # simulate one failure: see below
service/health-service.sh logs           # ~/Library/Logs/adabra-health.log
service/health-service.sh uninstall      # stops the job; the status file and the logs stay
```

Each line is OK, WARN or FAIL. **A FAIL means someone should act.** A WARN is worth knowing and nothing is broken.

| Check | OK | WARN | FAIL |
|---|---|---|---|
| `stop` | no stop in force | a stop, and since when. Past a day it also reminds you, but it is still a WARN: it was deliberate | the stop file cannot be read, so everything has stopped and nobody chose that. `resume` repairs it |
| `coordinator` | `/healthz` answers and the service runs | it answers but its service is not loaded, or it disagrees with the stop file about a stop | no answer, or not a healthy one |
| `helper` | running, and a pass in the last 2 minutes | not installed (this machine may not be a builder) | installed and not loaded or not running, or no recent pass |
| `reviewer` | running | | not installed, not loaded or not running |
| `docker` | the daemon answers | | not found, down, or no answer in 15 seconds |
| `tailscale` | `Running` | | anything else, not found, or stuck |
| `tailscale-serve` | proxies to the coordinator, tailnet only | | no such proxy, or one **not** marked tailnet only |
| `tailscale-key` | no expiry, or more than 30 days left | inside 30 days (reminds you), or it cannot be read | expired |
| `tailscale-login` | `TailscaleStartOnLogin` reads 1 | it reads 0, or cannot be read. What 0 and 1 mean is inferred from the name: Tailscale does not document it | |
| `disk` | 20 GB free or more | under 20 GB | under 5 GB |
| `backup` | installed, and `statusProblems` finds nothing | **not installed yet**: nothing has failed, but nothing is being backed up | installed and not loaded, no status, or any problem `backup-service.sh status` would report |
| `review-queue` | counts, and nothing has waited too long, or a stop or pause explains the wait | something has waited over 2 hours, one gave up in the last day, or the database is busy right now | something has waited over 6 hours, or the database is missing, stuck or broken |
| `review-pause` | not paused | a usage limit, which lifts by itself | a sign-in failure, which waits for you however long it takes |
| `logs` | counts and the largest | a symlink, hard link or folder with a log's name was left alone | a log could not be rotated, or the log folder is not a real folder |
| `health-job` | the job is keeping up | not installed yet. In the job itself, a gap since the last run (asleep or logged out) | installed, and not loaded or more than 45 minutes behind |

**Never stuck.** Every tool has its own short time limit, and each check has one too, so a stuck `docker` or `tailscale` is a FAIL line. A check that breaks is a line, and the rest still report. The checks run together, so one slow check makes no other late. A hard deadline of 2 minutes on its own thread ends a run that is stuck somewhere no timer can reach: launchd never starts a job that is still running, so without this one stuck run would be the last. If that happens the status file stays as it was, and its time shows it.

**Reading `reviewer.db`.** Only with SQLite's read-only flag, in a separate short-lived process, with a 500 ms busy timeout and an 8 second limit overall. It cannot write, cannot create a missing file, and changes no schema. It never uses `ReviewStore`, and it selects only counts, times and the kind of pause. As with the backup job, if nothing else has the database open, SQLite can leave an empty `-wal` and `-shm` beside it. They are harmless.

**The status file** is `~/.adabra-control/health-status.json` (or `ADABRA_HEALTH_STATUS`), beside the stop file, mode 644: agents and a later separate builder user can read it, and `.claude/settings.json` denies agents writing there. It is replaced whole on each run. It holds the lines, their levels, the time, and what has been notified. It never holds a token, the contents of a log, a database's contents, a stop's reason, a tool's output, or the tailnet's name: every line is built from counts, states, dates and fixed words.

```json
{
  "version": 1,
  "at": "2026-11-03T03:15:00.000Z",
  "next_by": "2026-11-03T04:00:00.000Z",
  "worst": "FAIL",
  "counts": { "OK": 13, "WARN": 1, "FAIL": 1 },
  "simulated": null,
  "lines": [{ "check": "docker", "level": "FAIL", "state": "down", "detail": "the Docker daemon is not answering, so PRs cannot be tested" }],
  "alerts": { "docker": { "level": "FAIL", "state": "down", "since": "2026-11-03T03:15:00.000Z", "notified_at": "2026-11-03T03:15:00.000Z" } }
}
```

**A dead job.** Nothing can notify you that the job itself has died. `at` is how you tell: past `next_by` (45 minutes), it has stopped. `health`, `health --last` and `health-service.sh status` all say so.

**Notifications don't nag.** What has been said is remembered under `alerts`, in that same file, so it survives restarts and reboots. A FAIL, or a WARN that asks for a reminder, notifies once when it appears and once when its level or state changes. A FAIL still there a day later is raised again, and a reminder a week later. When it clears you are told once, and it is forgotten. All of it goes in one notification per run. If a notification cannot be shown it stays due and is tried on the next run. Losing the file costs one repeat. If the file cannot be written, that is a FAIL of its own and notifies on every run, because nothing else is left to say so.

**If the login session is gone.** LaunchAgents need it, so while nobody is logged in the job does not run and nothing notifies you, which is why the mini must log in automatically. At the next login `RunAtLoad` runs it straight away, and the memory means you only hear what is new. A notification appears on the mini's own screen: it reaches you only if you are looking at the mini, or when you next open Notification Center there.

**Log rotation** is part of the job: the job already runs every 15 minutes, so a runaway log is caught within 15 minutes, and there is no second schedule to keep alive. A problem shows as its own line. Any `~/Library/Logs/adabra-*.log` over 10 MB is copied to `.1` (then `.2` and `.3`, and older ones go) and truncated in place, with no service restarted. launchd holds these files open for the service's whole life, so a rename would only make the service go on writing to the renamed file. Anything written between the last read of the copy and the truncate is lost: at most a line or two, once per rotation, accepted. Modes stay as they were, and the copy gets the log's mode. A symlink is never followed, out of the folder or anywhere else, and a hard link is left alone. These files hold untrusted PR output: they are copied as bytes, and nothing parses or prints them. `health` only reports sizes. Override records go in the reviewer's log, so they eventually roll off with it, after about 40 MB of that log.

**A simulated failure.** This fails one check on paper, through the status file and the notification, and touches no real service. The real probe is not even run. It can only make a check fail, never pass, so it cannot hide anything. It is a flag on one run, and the service has no way to be installed with it.

```bash
service/health-service.sh drill docker     # exits 1, a notification appears, and the docker line says SIMULATED
service/ops.sh health --last               # the same result, from the status file
service/health-service.sh run              # the real job: docker is fine again, so a "recovered" notification appears
service/ops.sh health --last               # back to how it really is
```

## GitHub App instead of personal tokens (Mac mini)

By default each service uses its token file. Set a service's three app settings and it uses short-lived installation tokens
instead: a JWT signed with the app's private key buys a token good for an hour, which is cached and renewed five minutes before
it expires. Set none and nothing changes. Set some, or set them wrong, and the service refuses to start. It never falls back to a
token file. Each service reads only its own settings and has its own key:

| Service | Settings | What its token is limited to |
|---|---|---|
| coordinator | `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_KEY_FILE` | Issues: write |
| reviewer | `REVIEW_APP_ID`, `REVIEW_APP_INSTALLATION_ID`, `REVIEW_APP_KEY_FILE` | Contents: read, Pull requests: write, Commit statuses: write, Issues: write |

Each token also covers only `GITHUB_REPO`. This limits what a leaked token can do. It is not a wall between the services: both run
as the same user, and whoever holds a key can ask for all of the app's permissions.

The key file must be an absolute path to a regular file outside this repository, owned by the service's user, with mode 600 or 400.
Git ignores `*.pem` and `*.key`. The review user cannot enter the service user's home folder (`review-check` proves it, as
`read.home`), so `~/.adabra` keeps the keys from the review step too.

### Setting it up

Do this in a browser on the mini, so the key never has to travel.

1. **Create the app.** On the account that owns the repository: profile picture > Settings > Developer settings > GitHub Apps >
   New GitHub App.
   - GitHub App name: your choice, under 35 characters. Comments will come from `<name>[bot]`.
   - Homepage URL: this repository's URL.
   - Webhook: untick **Active**. Nothing here uses webhooks.
   - Repository permissions: **Contents** Read-only, **Pull requests** Read and write, **Commit statuses** Read and write,
     **Issues** Read and write. **Metadata** stays Read-only, which GitHub requires. Leave everything else at No access.
   - Where can this GitHub App be installed: **Only on this account**.
   - Create GitHub App.
2. **Note the App ID**, shown at the top of the app's General page.
3. **Make two keys, one per service**, so either can be revoked alone. In the app's settings: Credentials > Key pairs > New key (on
   a page that says Private keys instead: Generate a private key). Each one downloads a `.pem` once, and GitHub keeps only the
   public half. Move them straight out of Downloads:
   ```bash
   umask 077; mkdir -p ~/.adabra; chmod 700 ~/.adabra
   mv ~/Downloads/<first-key>.pem ~/.adabra/coordinator-app-key.pem
   mv ~/Downloads/<second-key>.pem ~/.adabra/review-app-key.pem
   chmod 600 ~/.adabra/coordinator-app-key.pem ~/.adabra/review-app-key.pem
   ```
4. **Install it on this one repository.** In the app's settings: Install App > Install on your account > Only select repositories >
   this repository > Install.
5. **Note the installation ID**: the number at the end of the page's address, `https://github.com/settings/installations/<id>`.
   (You can get back there with Settings > Applications > Installed GitHub Apps > Configure.)
6. **Ask GitHub whether it all works**, with the code that has this feature. This only reads, and changes nothing that is running:
   ```bash
   GITHUB_REPO=Mominumer/adabra-agent-engine-test GITHUB_APP_ID=<app-id> GITHUB_APP_INSTALLATION_ID=<installation-id> \
     GITHUB_APP_KEY_FILE=$HOME/.adabra/coordinator-app-key.pem node coordinator/main.js github-check
   GITHUB_REPO=Mominumer/adabra-agent-engine-test REVIEW_APP_ID=<app-id> REVIEW_APP_INSTALLATION_ID=<installation-id> \
     REVIEW_APP_KEY_FILE=$HOME/.adabra/review-app-key.pem node reviewer/main.js github-check
   ```
   Each must end with `github-check passed`. Check two things it prints. The permissions must be the ones in the table above, plus
   `metadata=read`. The coordinator's count of labelled issues must match what `node coordinator/main.js tasks` lists from GitHub:
   task sync closes a task whose issue it cannot see, so an unexpectedly short list must stop you here.
7. **Switch the coordinator.** `install` runs the same check first, and if it fails, leaves the running service alone:
   ```bash
   GITHUB_APP_ID=<app-id> GITHUB_APP_INSTALLATION_ID=<installation-id> GITHUB_APP_KEY_FILE=$HOME/.adabra/coordinator-app-key.pem \
     service/coordinator-service.sh install
   ```
   The log (`service/coordinator-service.sh logs`) must say `GitHub auth: GitHub App ...`. Write a checkpoint on a task and see its
   progress comment change.
8. **Switch the reviewer.** `install` keeps only what it is given, so pass everything you installed it with last time, not only the
   new settings:
   ```bash
   REVIEW_APP_ID=<app-id> REVIEW_APP_INSTALLATION_ID=<installation-id> REVIEW_APP_KEY_FILE=$HOME/.adabra/review-app-key.pem \
     REVIEW_AUTHORS=... REVIEW_IMAGE=... REVIEW_DEVICE_ID=... REVIEW_COORDINATOR_URL=... \
     service/reviewer-service.sh install
   ```
   Push to an open PR: both checks must appear, from the app, and the PR's review comment must change.
9. **Retire the personal tokens** once this has run well for a few days. Revoke them at Settings > Developer settings > Personal
   access tokens > Fine-grained tokens, then `rm ~/.adabra/github-token ~/.adabra/review-token`. Keep them until then: they are how
   you switch back.

**To switch back,** run the same `install` commands without the app settings. With none set, the service uses its token file again.
If you have already revoked the token, make a new one first. To remove the app altogether, delete its keys and uninstall it at
Settings > Applications > Installed GitHub Apps.

### What looks different afterwards

- **Comments and commit statuses come from `<name>[bot]`,** not from a person. The services never commit, push or open a PR, so the
  app has no commits. Commits stay under whoever made them.
- **Comments written before the switch are still found.** Lookup goes by the hidden marker and never by author. GitHub says anyone
  with write access to a repository can edit others' comments, so the app is expected to edit them in place: the author shown stays
  the old one, and the edit history shows the app. GitHub's documents do not say this in so many words for an app, so the code also
  handles a refusal: it leaves the old comment as it stands, posts one new comment and carries on with that one, and the log says
  `GitHub refused an edit`. Either way there is no retry loop and no event is lost. The same goes for switching back.
- **`REVIEW_AUTHORS` is unaffected.** It lists who wrote a PR, and the app writes no PRs.
- **`service/ops.sh override` posts as the reviewer does,** so it needs nothing new from you in an emergency. It takes the three app
  settings from the reviewer's installed plist, unless you exported any of them yourself, and so it follows a switch in either
  direction. The status comes from `<name>[bot]` and still reads `operator override`. Run `node reviewer/main.js override` directly
  and only your shell's settings count, which without them means the token file.
- **Required checks are unaffected** as long as they accept any source, which `main`'s do today. If someone pins a required check
  to a particular app in branch protection, it must be this one.

### If GitHub will not issue a token

The service stays up and nothing is lost. Whether GitHub is down, the key was revoked, the app was uninstalled or a permission was
removed, the coordinator's events and the reviewer's jobs wait and retry every 30 seconds without using up an attempt, so they
cannot go `dead` or `failed` this way, and they carry on by themselves once the problem is fixed. The log says `not counted as an
attempt` and gives the reason. A wrong app ID or installation ID shows up this way as well, because a refusal from GitHub cannot
be told apart from one on a bad day: that is what step 6 is for.

An emergency stop comes first. While one is in force the worker and the reviewer attempt nothing and count nothing, and work held for
an outage stays held. After `resume`, a problem that remains holds the work in the same way, and a token that expired during the stop
is replaced on first use. A stop does not end the read-only task sync, which still asks GitHub for a token when it needs one: that
writes nothing to the repository. `override` cannot post without a token: it says so, and posts nothing.

## Not built yet (by design)

Claim/lease validation (`claim_generation` is carried but not checked), cancellation, review workers, context
delivery, Slack. See the blueprint milestones M3-M7.
