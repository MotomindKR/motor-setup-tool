param(
  [Parameter(Mandatory = $true)][string]$OldInstaller,
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'
$testRoot = Join-Path $env:RUNNER_TEMP 'motomind-update-tests'
$machineDirectory = Join-Path $testRoot 'Machine App'
$userDirectory = Join-Path $testRoot 'User App'
$stateDirectory = Join-Path $env:APPDATA 'motomind-motor-calib-electron'
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

function Install-Previous([string]$Scope, [string]$Directory) {
  $process = Start-Process -FilePath $OldInstaller -ArgumentList "/S $Scope /D=$Directory" -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Previous installer failed: $($process.ExitCode)" }
  if (-not (Test-Path (Join-Path $Directory 'Motor Setup Tool.exe'))) { throw "Previous app missing in $Directory" }
}

function Test-Update([string]$Name, [string]$Directory, [string]$Setup, [string]$ExpectedVersion, [string]$ExpectedError = '') {
  Write-Output "Testing $Name in $Directory"
  $caseDirectory = Join-Path $testRoot $Name
  New-Item -ItemType Directory -Path $caseDirectory -Force | Out-Null
  $appExe = Join-Path $Directory 'Motor Setup Tool.exe'
  $screenshot = Join-Path $caseDirectory 'restarted.png'
  try {
    & node "$PSScriptRoot\windows-update-worker.js" $Setup $ExpectedVersion $appExe $stateDirectory $screenshot
    if ($LASTEXITCODE -ne 0) { throw 'The update handoff failed' }
    $deadline = (Get-Date).AddSeconds(150)
    while (-not (Test-Path "$screenshot.json")) {
      if ((Get-Date) -ge $deadline) { throw 'The updated app did not restart and report its runtime version' }
      Start-Sleep -Milliseconds 500
    }
    $runtime = Get-Content "$screenshot.json" -Raw | ConvertFrom-Json
    if ($runtime.version -ne $Version) { throw "Restarted runtime version $($runtime.version) does not match $Version" }
    if ($ExpectedError) {
      if ($runtime.updateError -notlike "*$ExpectedError*") { throw "Expected visible update error, got: $($runtime.updateError)" }
      if (-not $runtime.settingsOpen) { throw 'The failed update was not shown in Settings on restart' }
    } else {
      if ($runtime.updateError) { throw $runtime.updateError }
      $actual = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($appExe).ProductVersion
      if ($actual -ne $Version -and $actual -ne "$Version.0") { throw "Launcher version $actual does not match $Version" }
      if (Test-Path (Join-Path $stateDirectory 'pending-update.json')) { throw 'The restarted app did not verify its pending update' }
    }
    Write-Output "Passed $Name : runtime=$($runtime.version)"
  } finally {
    Copy-Item "$stateDirectory\update*" $caseDirectory -Force -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name = 'Motor Setup Tool.exe'" | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($testRoot, [System.StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}

# A bare /S chooses the machine installation when both scopes are registered,
# even when the update was requested from the user installation.
Install-Previous '/allusers' $machineDirectory
Install-Previous '/currentuser' $userDirectory
Test-Update 'user-with-machine-copy' $userDirectory $Installer $Version
Test-Update 'machine-with-user-copy' $machineDirectory $Installer $Version

Install-Previous '/currentuser' $userDirectory
Test-Update 'custom-user-directory' $userDirectory $Installer $Version

# Exercise a real failed executable and the restarted app's error display.
$failureSource = Join-Path $testRoot 'failed-installer.cs'
$failureExe = Join-Path $testRoot 'failed-installer.exe'
Set-Content $failureSource 'public class Program { public static int Main() { return 7; } }'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe "/out:$failureExe" $failureSource
if ($LASTEXITCODE -ne 0) { throw 'Failed to compile failure fixture' }
Test-Update 'installer-failure' $userDirectory $failureExe '99.0.0' 'Installer exited with code 7'
