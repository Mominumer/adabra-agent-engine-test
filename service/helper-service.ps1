# Run the helper background agent on Windows as a Task Scheduler task (starts at logon, comes back after a crash).
# It keeps held task leases alive and delivers queued checkpoints, so nobody runs heartbeat/flush by hand.
# The Windows counterpart of service/helper-service.sh. Needs no admin rights and stores no password.
# Enroll first: node helper\cli.js enroll <url> <device-id>, then save the device token to %USERPROFILE%\.team-agent\token.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File service\helper-service.ps1 install     register the task and start it
#   powershell -NoProfile -ExecutionPolicy Bypass -File service\helper-service.ps1 status      is it running, and what did the last pass do
#   powershell -NoProfile -ExecutionPolicy Bypass -File service\helper-service.ps1 logs        follow the log
#   powershell -NoProfile -ExecutionPolicy Bypass -File service\helper-service.ps1 uninstall   stop it and remove the task
#   powershell -NoProfile -ExecutionPolicy Bypass -File service\helper-service.ps1 protect     make TEAM_AGENT_HOME private to this user (onboarding uses this)
#
# What runs: Task Scheduler -> wscript.exe helper-launcher.js (no window) -> node helper\supervisor.js -> node helper\agent.js
# How it comes back:
#   the agent dies           the supervisor starts it again after 10 seconds
#   anything above it dies   the one-minute trigger starts the task again; while it is running, IgnoreNew makes that a no-op
# The trigger does the work "restart on failure" would be asked to do. That setting has a capped count and is reported
# not to fire when a program starts and later exits non-zero, so nothing here depends on it.
#
# This script never opens the token. It only checks that the file exists and who is allowed to read it.
param([string]$Command = '')

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    [Console]::Error.WriteLine('this script is for Windows; use service/helper-service.sh on macOS')
    exit 1
}

$TaskName = 'ai.adabra.helper'
$Task = @{ TaskName = $TaskName; TaskPath = '\' } # the root folder, where any user can add a task of their own
$RepoDir = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot 'helper-launcher.js'
$Supervisor = Join-Path (Join-Path $RepoDir 'helper') 'supervisor.js'
$LogFile = Join-Path $env:LOCALAPPDATA 'Adabra\Logs\adabra-helper.log'
if ($env:TEAM_AGENT_HOME) {
    $AgentHome = $env:TEAM_AGENT_HOME.TrimEnd('\') # a trailing backslash would escape the closing quote on a command line
} else {
    $AgentHome = Join-Path $env:USERPROFILE '.team-agent'
}
$TokenFile = Join-Path $AgentHome 'token'
$AgentPattern = '(^|[\s"\\/])helper[\\/](agent|supervisor)\.js'

function Exit-WithError([string]$message) {
    [Console]::Error.WriteLine($message)
    exit 1
}

# The real node.exe. What PATH finds may be a shim (nvm, volta, scoop) that only works inside a shell.
function Find-Node {
    $found = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) {
        Exit-WithError 'node not found on PATH: install Node 22.13 or newer, open a new terminal, and run install again'
    }
    $onPath = $found.Source
    $exe = (& $onPath -p 'process.execPath').Trim()
    $parts = (& $exe -p 'process.versions.node').Trim().Split('.')
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 13)) {
        Exit-WithError "node $major.$minor is too old: the helper needs Node 22.13 or newer"
    }
    $exe
}

# This user's agents and supervisors, found by command line because ending a task may not end what it started.
function Get-AgentProcesses {
    $session = (Get-Process -Id $PID).SessionId
    Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.SessionId -eq $session -and $_.CommandLine -match $AgentPattern }
}

function Stop-AgentProcesses {
    # Supervisors first, or a supervisor would start the agent again.
    foreach ($name in 'supervisor', 'agent') {
        Get-AgentProcesses | Where-Object { $_.CommandLine -match "$name\.js" } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    # Stop-Process returns before the process is gone; starting a new agent too early would leave two side by side.
    for ($i = 0; $i -lt 20 -and @(Get-AgentProcesses).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }
}

function Remove-AgentTask {
    if (Get-ScheduledTask @Task -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask @Task -ErrorAction SilentlyContinue
        Unregister-ScheduledTask @Task -Confirm:$false
    }
}

# What chmod 600 does on macOS: only this user, SYSTEM and Administrators can get in, and files inside inherit that.
# A home under %USERPROFILE% already has this; a TEAM_AGENT_HOME elsewhere may well not.
function Protect-AgentHome {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $null = & icacls.exe $AgentHome /inheritance:r /grant:r "*${me}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "could not restrict access to $AgentHome (icacls exit code $LASTEXITCODE)"
    }
}

# Who else may open this path. Reads the access list, never the file.
function Get-UnexpectedAccess([string]$path) {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0') # this user, SYSTEM, Administrators, CREATOR OWNER
    $rules = (Get-Acl -LiteralPath $path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference
        if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $sid.Value) {
            try { $sid.Translate([Security.Principal.NTAccount]).Value } catch { $sid.Value }
        }
    }
}

function Show-AccessWarnings {
    foreach ($path in $AgentHome, $TokenFile) {
        if (Test-Path -LiteralPath $path) {
            $others = @(Get-UnexpectedAccess $path)
            if ($others.Count -gt 0) {
                Write-Warning "$path can also be opened by: $($others -join ', '). Run install again, or remove them with icacls."
            }
        }
    }
}

# Written as XML to get exactly these settings; see the Task Scheduler schema.
#   InteractiveToken + LeastPrivilege  runs as this user in their desktop session: no password, no elevation, and
#                                      notifications can show. S4U needs the batch logon right, which ordinary users
#                                      lack, and is documented as having no network access.
#   LogonTrigger                       starts at logon. It must name the user: "any user" needs admin rights.
#   TimeTrigger, every minute          the watchdog, and it is why a crash is recovered. A logon trigger's repetition
#                                      would only begin at the next logon, so it could not cover the time after install.
#   IgnoreNew                          the watchdog does nothing while the task is running.
#   ExecutionTimeLimit PT0S            no time limit (the default kills a task after three days).
function New-TaskXml([string]$nodeExe) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $userName = [Security.SecurityElement]::Escape($identity.Name)
    $userSid = $identity.User.Value
    $startAt = (Get-Date).ToString('s')
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $arguments = '//B //NoLogo //E:JScript "{0}" "{1}" "{2}" "{3}" "{4}"' -f $Launcher, $nodeExe, $Supervisor, $AgentHome, $LogFile
    $arguments = [Security.SecurityElement]::Escape($arguments)
    $workingDir = [Security.SecurityElement]::Escape($RepoDir)
    @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Adabra helper agent: keeps held task leases alive and delivers queued checkpoints.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$userName</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>$startAt</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$userSid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$wscript</Command>
      <Arguments>$arguments</Arguments>
      <WorkingDirectory>$workingDir</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

function Install-AgentTask {
    $nodeExe = Find-Node
    $configFile = Join-Path $AgentHome 'config.json'
    if (-not (Test-Path -LiteralPath $configFile) -or -not (Test-Path -LiteralPath $TokenFile)) {
        Exit-WithError "not enrolled: run node helper\cli.js enroll first and save the token to $TokenFile"
    }
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile)
    Protect-AgentHome

    # Take the old task down completely before registering the new one, so re-installing never leaves two agents.
    Remove-AgentTask
    Stop-AgentProcesses

    $xml = New-TaskXml $nodeExe
    $reason = ''
    $registered = $false
    for ($i = 0; $i -lt 5 -and -not $registered; $i++) {
        try {
            $null = Register-ScheduledTask @Task -Xml $xml -Force
            $registered = $true
        } catch {
            $reason = $_.Exception.Message
            Start-Sleep -Seconds 1
        }
    }
    if (-not $registered) {
        Exit-WithError "could not register ${TaskName}: $reason"
    }
    Start-ScheduledTask @Task

    # Two processes when it is up: the supervisor and the agent.
    for ($i = 0; $i -lt 15 -and @(Get-AgentProcesses).Count -lt 2; $i++) { Start-Sleep -Seconds 1 }
    Show-Status
    if (@(Get-AgentProcesses).Count -lt 2) {
        Exit-WithError "the task is registered but the agent did not start: see the last result and the log above. Is Windows Script Host disabled, or did antivirus block helper-launcher.js?"
    }
}

function Show-Status {
    $registered = Get-ScheduledTask @Task -ErrorAction SilentlyContinue
    if ($registered) {
        $info = Get-ScheduledTaskInfo @Task
        Write-Output "state = $($registered.State)"
        Write-Output "last run = $($info.LastRunTime)"
        Write-Output "last result = $('0x{0:X}' -f $info.LastTaskResult) (0x0 ok, 0x41301 running, 0x41303 not run yet)"
        $running = @(Get-AgentProcesses)
        foreach ($process in $running) {
            if ($process.CommandLine -match 'supervisor\.js') { $role = 'supervisor' } else { $role = 'agent' }
            Write-Output "$role pid = $($process.ProcessId)"
        }
        if ($running.Count -eq 0) {
            Write-Output 'not running right now: the task tries again within a minute (and needs you to be logged on)'
        }
    } else {
        Write-Output 'service not loaded'
    }
    Show-AccessWarnings
    $statusFile = Join-Path $AgentHome 'agent-status.json'
    if (Test-Path -LiteralPath $statusFile) {
        Get-Content -LiteralPath $statusFile -Raw -ErrorAction SilentlyContinue
    } else {
        Write-Output 'no agent-status.json yet'
    }
    Write-Output ''
    Write-Output "log: $LogFile"
}

switch ($Command) {
    'install' {
        Install-AgentTask
    }
    'status' {
        Show-Status
    }
    'logs' {
        if (-not (Test-Path -LiteralPath $LogFile)) { Exit-WithError "no log yet: $LogFile" }
        Get-Content -LiteralPath $LogFile -Tail 50 -Wait -Encoding UTF8
    }
    'uninstall' {
        Remove-AgentTask
        Stop-AgentProcesses
        Write-Output "removed $TaskName"
    }
    'protect' {
        # For onboarding/setup.js: make the folder private before a token goes in, and report who else can open what is there.
        $null = New-Item -ItemType Directory -Force -Path $AgentHome
        Protect-AgentHome
        Show-AccessWarnings
    }
    default {
        Write-Output 'usage: helper-service.ps1 install | status | logs | uninstall'
        exit 2
    }
}
