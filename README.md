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
dispatcher's home folder. This part builds and proves that boundary. **Nothing here can call Claude**: the wrapper has no model
step, never loads the credential, and exits 78 if asked to review. `adabra/review` is still the mock.

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

## Not built yet (by design)

Claim/lease validation (`claim_generation` is carried but not checked), cancellation, review workers, context
delivery, Slack. See the blueprint milestones M3-M7.
