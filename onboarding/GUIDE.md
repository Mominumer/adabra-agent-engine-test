# Set up your machine as a builder

Coding work on this project is shared out through a small service called the coordinator. This sets up your machine to take
part. It takes a few minutes, and you only do it once.

## What you need

**From your operator** (the person who invited you):

- the repository's address, and a ready-made setup command. It holds the coordinator's address, your device ID and a test task.
- your device token, sent privately. Treat it like a password: don't paste it into a chat, an email or a command.

**On your machine:** Node 22.13 or newer, git, and Tailscale signed in with the account your operator invited. The script checks
all of these, tells you exactly how to fix what is missing, and installs none of them for you. It needs no admin rights.

## What to run

Open a terminal (PowerShell on Windows, not the ISE), then:

```
git clone <repository address>
cd <the new folder>
```

If git is not found, install it first: `xcode-select --install` on a Mac, https://git-scm.com/download/win on Windows.
Then run the command your operator sent you. It looks like one of these:

```
onboarding/setup-mac.sh --coordinator <address> --device <device-id> --test-task <TASK-N>

powershell -NoProfile -ExecutionPolicy Bypass -File onboarding\setup-windows.ps1 --coordinator <address> --device <device-id> --test-task <TASK-N>
```

When asked, paste the token and press Enter. **Nothing shows as you paste**: that is on purpose. If you were sent the token as a
file, add `--token-file <that file>` to the command and you won't be asked.

## What success looks like

The last lines start with `SUCCESS: device <your device ID> is set up`. By then the script has saved your token where only you
can read it, installed a background helper that starts when you log in, and run a first test on the test task: it claims the task,
writes one fixed line on the task's public issue, and lets the task go. The line shows your device ID and nothing else about you.

Afterwards, delete anything the token came in, and copy something else so it isn't left on your clipboard.

## When something fails

The script prints `FAIL` or `REFUSED`, then what to do. Do that and run the same command again. That is always safe: it keeps
what is done, and never replaces a saved enrolment or token without you moving it out of the way first.

| What you see | What it probably means | What to do |
| --- | --- | --- |
| Could not reach the coordinator | You are not on the tailnet yet, or the address is wrong | Connect Tailscale, check the address, and ask your operator for an invitation if you have none |
| Tailscale is not installed, switched off or not signed in | Just that | Follow the line printed under it |
| The coordinator refused that token | It was pasted wrongly, is for another device, or was revoked | Copy it again; if it is still refused, ask your operator |
| Refused the claim, or the task does not exist | The test task is taken, reserved or mistyped | Ask your operator for another test task |
| Already enrolled | This machine was set up before | Follow the lines printed under it |
| The test claim could not be released | The connection dropped during the test | Run the release command it prints |

## Who to ask

Your operator. Send them the `FAIL` or `REFUSED` lines, which never contain your token. Never send the token itself. If you
think it has been seen by anyone else, tell them at once: they can replace it in a moment.

The Windows script has not yet been run on a real Windows machine. If yours is the first, your operator will want to hear how it goes.
