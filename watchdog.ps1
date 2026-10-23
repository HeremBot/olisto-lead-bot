# Watchdog Olisto Lead Bot : relance le bot si mort ou fige (heartbeat stale > 5 min)
$dir = "C:\Users\roly\Documents\HEREM\olisto-lead-bot"
$lock = Join-Path $dir "bot.lock"
$node = "C:\Program Files\nodejs\node.exe"
$bot = Join-Path $dir "bot.js"
$logDir = Join-Path $dir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir "watchdog.log"
function Log($m) { Add-Content $log ("[{0}] {1}" -f (Get-Date -Format 'dd/MM/yyyy HH:mm:ss'), $m) }

$needStart = $true
if (Test-Path $lock) {
  $d = $null
  try { $d = Get-Content $lock -Raw | ConvertFrom-Json } catch {}
  if ($d -and $d.pid) {
    $alive = $false
    try { $p = Get-Process -Id $d.pid -ErrorAction Stop; $alive = ($p.ProcessName -match 'node') } catch {}
    $age = 9999
    if ($d.ts) {
      try { $age = ((Get-Date) - [datetime]$d.ts).TotalMinutes } catch {}
    }
    if ($alive -and $age -le 5) {
      $needStart = $false
    } elseif ($alive) {
      Log ("Heartbeat stale ({0} min) -> kill PID {1} et relance" -f [math]::Round($age, 1), $d.pid)
      Stop-Process -Id $d.pid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
    } else {
      Log ("PID {0} mort -> relance" -f $d.pid)
    }
  } else {
    Log "Lock illisible -> relance"
  }
}
if ($needStart) {
  Log "Demarrage bot"
  Start-Process -FilePath $node -ArgumentList ('"' + $bot + '"') -WorkingDirectory $dir -WindowStyle Hidden
}
