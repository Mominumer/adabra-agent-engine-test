# Set up this Windows machine as a builder: checks what it needs, enrols it, saves the token, installs the background helper
# and runs a first test. Safe to run again. onboarding\GUIDE.md explains it; your operator gives you the values.
# Needs no admin rights and installs nothing without being asked. **Not yet run on a real Windows machine.**
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File onboarding\setup-windows.ps1 --coordinator <address> --device <device-id> --test-task <TASK-N>
#
# Run with --help for the options. This only makes sure Node can run onboarding\setup.js, which does the work.
#
# Nothing in this file touches the token, on purpose. setup.js reads it from the console with echo off, and no Read-Host means
# nothing for PowerShell or the console to keep. Node then writes plain ASCII bytes, so the file cannot end up in the UTF-16 or
# with the BOM that Windows PowerShell 5.1's own commands would give it, and the folder's access list keeps it to this user.
$ErrorActionPreference = 'Stop'

function Exit-WithError([string]$message) {
    [Console]::Error.WriteLine($message)
    exit 1
}

if ($env:OS -ne 'Windows_NT') {
    Exit-WithError 'this script is for Windows; use onboarding/setup-mac.sh on macOS'
}

$RepoDir = Split-Path -Parent $PSScriptRoot
$Cli = Join-Path (Join-Path $RepoDir 'helper') 'cli.js'
$Setup = Join-Path $PSScriptRoot 'setup.js'
$NodeFix = 'Install it from https://nodejs.org/en/download, open a new terminal, and run this again.'

$found = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $found) {
    Exit-WithError "Node was not found: this needs Node 22.13 or newer. $NodeFix"
}
$version = (& $found.Source -p 'process.versions.node').Trim()
$parts = $version.Split('.')
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 13)) {
    Exit-WithError "Node $version is too old: this needs Node 22.13 or newer. $NodeFix"
}
if (-not (Test-Path -LiteralPath $Cli) -or -not (Test-Path -LiteralPath $Setup)) {
    Exit-WithError 'The repository was not found around this script. Run git clone with the address from your operator, then run this script from the new folder.'
}

# From here on, Node's own error output must reach the console as it is, and not stop PowerShell.
$ErrorActionPreference = 'Continue'
& $found.Source $Setup @args
exit $LASTEXITCODE
