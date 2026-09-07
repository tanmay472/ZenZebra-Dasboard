# Windows equivalent of worker-health-check.service/.timer (the systemd
# watchdog used on the Oracle VM deployment path). Reuses the exact same
# liveness probe (scripts/check-worker-health.mjs - reads the persisted
# worker_heartbeat row, same freshness threshold) so "healthy" means the
# same thing on both platforms. If the heartbeat is stale, restarts
# sync-worker.mjs (killing any tracked-but-dead process first) - same
# recovery role as the systemd timer's restart logic.
#
# Install (run once, as the user who should own the worker process):
#   schtasks /Create /SC MINUTE /MO 2 /TN "ZenZebraSyncWorkerWatchdog" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File <repo>\deploy\windows-watchdog.ps1" /RL LIMITED /F
#
# Uninstall:
#   schtasks /Delete /TN "ZenZebraSyncWorkerWatchdog" /F
#
# Logs: deploy/logs/watchdog.log (this script), deploy/logs/sync-worker.log
# (the worker process's own stdout/stderr).

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$logDir = Join-Path $repoRoot "deploy\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$watchdogLog = Join-Path $logDir "watchdog.log"
$workerLog = Join-Path $logDir "sync-worker.log"
$pidFile = Join-Path $logDir "sync-worker.pid"

function Write-Log($message) {
	$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
	"$timestamp $message" | Out-File -FilePath $watchdogLog -Append -Encoding utf8
}

node scripts/check-worker-health.mjs | Out-Null
$healthy = ($LASTEXITCODE -eq 0)

if ($healthy) {
	Write-Log "OK: worker heartbeat is fresh."
	exit 0
}

Write-Log "UNHEALTHY: heartbeat stale or missing. Attempting restart..."

if (Test-Path $pidFile) {
	$oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
	if ($oldPid) {
		try {
			Stop-Process -Id $oldPid -Force -ErrorAction Stop
			Write-Log "Killed stale worker process (PID $oldPid)."
		} catch {
			Write-Log "No live process at PID $oldPid (already dead) - continuing."
		}
	}
}

$proc = Start-Process -FilePath "node" -ArgumentList "sync-worker.mjs" -WorkingDirectory $repoRoot -RedirectStandardOutput $workerLog -RedirectStandardError "$workerLog.err" -WindowStyle Hidden -PassThru

$proc.Id | Out-File -FilePath $pidFile -Encoding ascii
Write-Log "Restarted worker (new PID $($proc.Id))."
