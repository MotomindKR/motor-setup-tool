param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$AppExe,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$ResultFile,
  [string]$ReadyFile
)

$ErrorActionPreference = 'Stop'
$exitCode = 0
$restart = $false
$workDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($ResultFile))
$logFile = Join-Path $workDirectory 'update.log'

function Write-UpdateLog([string]$Message) {
  Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

function Same-Directory([string]$Left, [string]$Right) {
  if (-not $Left -or -not $Right) { return $false }
  return [System.IO.Path]::GetFullPath($Left).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($Right).TrimEnd('\')
}

function Get-InstallScope([string]$Directory) {
  foreach ($scope in @(@('HKCU:', '/currentuser'), @('HKLM:', '/allusers'))) {
    foreach ($view in @('Software', 'Software\WOW6432Node')) {
      $entries = Get-ItemProperty "$($scope[0])\$view\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue
      foreach ($entry in $entries) {
        if ($entry.DisplayName -notmatch '^Motor Setup Tool(?: \d+\.\d+\.\d+)?$') { continue }
        $location = (Get-ItemProperty "$($scope[0])\$view\$($entry.PSChildName)" -ErrorAction SilentlyContinue).InstallLocation
        if (-not $location -and $entry.UninstallString -match '^"([^"]+)"') {
          $location = Split-Path -Parent $Matches[1]
        }
        if (Same-Directory $location $Directory) { return $scope[1] }
      }
    }
  }
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($root -and $Directory.StartsWith("$root\", [System.StringComparison]::OrdinalIgnoreCase)) { return '/allusers' }
  }
  return '/currentuser'
}

function Get-InstallProcesses {
  Get-CimInstance Win32_Process -Filter "Name = 'Motor Setup Tool.exe' OR Name = 'motor-setup-tool.exe'" | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$installDirectory\", [System.StringComparison]::OrdinalIgnoreCase)
  }
}

try {
  New-Item -ItemType Directory -Path $workDirectory -Force | Out-Null
  Set-Location -LiteralPath $workDirectory
  [System.Environment]::CurrentDirectory = $workDirectory
  $AppExe = [System.IO.Path]::GetFullPath($AppExe)
  $installDirectory = Split-Path -Parent $AppExe
  $scope = Get-InstallScope $installDirectory
  Write-UpdateLog "Starting update to $ExpectedVersion; scope=$scope; app=$AppExe; installer=$Installer"
  if ($ReadyFile) { [System.IO.File]::WriteAllText($ReadyFile, 'ready') }
  $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if ($parent) { $parent | Wait-Process -Timeout 60 }
  $restart = $true

  # Chromium children can outlive the main process. A separate app instance
  # must close normally so any motor operation can stop through its backend.
  $deadline = (Get-Date).AddSeconds(10)
  while (@(Get-InstallProcesses).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  $remainingProcesses = @(Get-InstallProcesses)
  if (@($remainingProcesses | Where-Object { $_.CommandLine -notmatch '\s--type=' }).Count -gt 0) {
    throw 'Another app instance or motor backend is still running. Stop its operation and close it before updating.'
  }
  foreach ($remaining in $remainingProcesses) {
    Write-UpdateLog "Stopping remaining Chromium process $($remaining.ProcessId)"
    Stop-Process -Id $remaining.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $deadline = (Get-Date).AddSeconds(10)
  while (@(Get-InstallProcesses).Count -gt 0) {
    if ((Get-Date) -ge $deadline) { throw 'App processes are still running; close other Motor Setup Tool windows and retry.' }
    Start-Sleep -Milliseconds 200
  }

  # NSIS requires /D to be last, with no quotes even when the path has spaces.
  $start = @{
    FilePath = $Installer
    ArgumentList = "/S $scope --updated /D=$installDirectory"
    WorkingDirectory = $workDirectory
    Wait = $true
    PassThru = $true
  }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
  if ($scope -eq '/allusers' -and -not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $start.Verb = 'RunAs'
  }
  $process = Start-Process @start
  Write-UpdateLog "Installer exit code $($process.ExitCode)"
  if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode)."
  }
  if (-not (Test-Path -LiteralPath $AppExe)) {
    throw 'The installed app was not found after setup.'
  }
  $installedVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($AppExe).ProductVersion
  if ($installedVersion -ne $ExpectedVersion -and $installedVersion -ne "$ExpectedVersion.0") {
    throw "Installed version is $installedVersion; expected $ExpectedVersion."
  }
  $manifest = Get-Content -LiteralPath (Join-Path $installDirectory 'resources\app\package.json') -Raw | ConvertFrom-Json
  if ($manifest.version -ne $ExpectedVersion) {
    throw "Installed UI version is $($manifest.version); expected $ExpectedVersion."
  }
  Write-UpdateLog "Verified launcher and UI version $ExpectedVersion in $installDirectory"
  Remove-Item -LiteralPath $ResultFile -Force -ErrorAction SilentlyContinue
} catch {
  $exitCode = 1
  $message = "Update failed: $($_.Exception.Message) Details: $logFile"
  [System.IO.File]::WriteAllText($ResultFile, $message)
  Write-UpdateLog $message
} finally {
  if ($ReadyFile) { Remove-Item -LiteralPath $ReadyFile -Force -ErrorAction SilentlyContinue }
  try {
    if ($restart -and (Test-Path -LiteralPath $AppExe)) {
      Start-Process -FilePath $AppExe -WorkingDirectory $workDirectory
    }
  } catch {
    $exitCode = 1
    [System.IO.File]::WriteAllText($ResultFile, "Could not restart the app: $($_.Exception.Message) Details: $logFile")
  }
}
exit $exitCode
