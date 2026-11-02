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
- **Required checks are unaffected** as long as they accept any source, which `main`'s do today. If someone pins a required check
  to a particular app in branch protection, it must be this one.

### If GitHub will not issue a token

The service stays up and nothing is lost. Whether GitHub is down, the key was revoked, the app was uninstalled or a permission was
removed, the coordinator's events and the reviewer's jobs wait and retry every 30 seconds without using up an attempt, so they
cannot go `dead` or `failed` this way, and they carry on by themselves once the problem is fixed. The log says `not counted as an
attempt` and gives the reason. A wrong app ID or installation ID shows up this way as well, because a refusal from GitHub cannot
be told apart from one on a bad day: that is what step 6 is for.

## Not built yet (by design)

Claim/lease validation (`claim_generation` is carried but not checked), cancellation, review workers, context
delivery, Slack. See the blueprint milestones M3-M7.
