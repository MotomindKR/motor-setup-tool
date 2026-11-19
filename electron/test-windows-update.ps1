param(
  [Parameter(Mandatory = $true)][string]$OldInstaller,
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$NextInstaller
)

$ErrorActionPreference = 'Stop'
function Get-InstallerVersion([string]$Path) {
  [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion -replace '^(\d+\.\d+\.\d+)\.0$', '$1'
}
$Version = Get-InstallerVersion $Installer
$PreviousVersion = Get-InstallerVersion $OldInstaller
$testRoot = Join-Path $env:RUNNER_TEMP 'motomind-update-tests'
$machineDirectory = Join-Path $testRoot 'Machine App'
$userDirectory = Join-Path $testRoot 'User App'
$stateDirectory = Join-Path $env:APPDATA 'motomind-motor-calib-electron'
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null

function Install-Previous([string]$Scope, [string]$Directory) {
  $process = Start-Process -FilePath $OldInstaller -ArgumentList "/S $Scope /D=$Directory" -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Previous installer failed: $($process.ExitCode)" }
  if (-not (Test-Path (Join-Path $Directory 'Motor Setup Tool.exe'))) { throw "Previous app missing in $Directory" }
}

function Test-Update([string]$Name, [string]$Directory, [string]$Setup, [string]$ExpectedVersion, [string]$ExpectedError = '', [string]$FromVersion = $PreviousVersion) {
  $Version = Get-InstallerVersion $Setup
  Write-Output "Testing $Name in $Directory ($FromVersion -> $ExpectedVersion)"
  $caseDirectory = Join-Path $testRoot $Name
  New-Item -ItemType Directory -Path $caseDirectory -Force | Out-Null
  $appExe = Join-Path $Directory 'Motor Setup Tool.exe'
  $screenshot = Join-Path $caseDirectory 'restarted.png'
  $handoff = Join-Path $caseDirectory 'handoff.json'
  try {
    $appRoot = Join-Path $Directory 'resources\app'
    Copy-Item (Join-Path $PSScriptRoot 'packaged-update-worker.js') (Join-Path $appRoot 'electron\packaged-update-worker.js') -Force
    $manifestFile = Join-Path $appRoot 'package.json'
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    $entry = $manifest.main
    $manifest.main = 'electron/packaged-update-worker.js'
    [System.IO.File]::WriteAllText($manifestFile, ($manifest | ConvertTo-Json))
    $configFile = Join-Path $caseDirectory 'request.json'
    [System.IO.File]::WriteAllText($configFile, (@{
      entry = $entry; installer = $Setup; version = $ExpectedVersion; directory = $stateDirectory
      screenshot = $screenshot; handoff = $handoff; badChecksum = [bool]$ExpectedError
    } | ConvertTo-Json))
    $env:MOTOMIND_UPDATE_TEST_CONFIG = $configFile
    # Launch a GUI app as Explorer would, without a Node console parent.
    $running = Start-Process -FilePath $appExe -WorkingDirectory $Directory -PassThru
    if (-not $running.WaitForExit(45000)) { throw 'The packaged app did not complete its update handoff' }
    if ($running.ExitCode -ne 0) { throw "The packaged app update handoff failed ($($running.ExitCode))" }
    if (-not $ExpectedError) {
      $source = Get-Content -LiteralPath $handoff -Raw | ConvertFrom-Json
      if ($source.version -ne $FromVersion -or $source.target -ne $ExpectedVersion) {
        throw "Expected $FromVersion to download $ExpectedVersion, saw $($source.version) download $($source.target)"
      }
      $deadline = (Get-Date).AddSeconds(75)
      do {
        $restarted = Get-Process -Name 'Motor Setup Tool' -ErrorAction SilentlyContinue | Where-Object {
          $_.Path -ieq $appExe -and $_.Id -ne $running.Id -and $_.MainWindowHandle -ne 0
        } | Select-Object -First 1
        if ($restarted) { break }
        Start-Sleep -Milliseconds 250
      } while ((Get-Date) -lt $deadline)
      if (-not $restarted) { throw "Windows did not reopen a window for $appExe after the update" }
      $launch = Get-CimInstance Win32_Process -Filter "ProcessId = $($restarted.Id)"
      $parent = Get-Process -Id $launch.ParentProcessId -ErrorAction SilentlyContinue
      Write-Output "Relaunched PID $($launch.ProcessId), parent $($launch.ParentProcessId) ($($parent.ProcessName)), command $($launch.CommandLine)"
      if ($launch.CommandLine -notmatch '(?:^|\s)--updated(?:\s|$)' -or (Get-InstallerVersion $restarted.Path) -ne $Version) {
        throw "Unexpected process or version in the reopened window"
      }
      if (-not $restarted.CloseMainWindow() -or -not $restarted.WaitForExit(15000)) { throw 'The updated app did not close normally' }
      $env:MOTOMIND_SMOKE_PATH = $screenshot
      $smoke = Start-Process -FilePath $appExe -WorkingDirectory $Directory -PassThru
      if (-not $smoke.WaitForExit(30000) -or $smoke.ExitCode -ne 0) { throw 'The updated app runtime smoke check failed' }
      Remove-Item Env:MOTOMIND_SMOKE_PATH -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds(150)
    while (-not (Test-Path "$screenshot.json")) {
      if ((Get-Date) -ge $deadline) { throw 'The updated app did not restart and report its runtime version' }
      Start-Sleep -Milliseconds 500
    }
    $runtime = Get-Content "$screenshot.json" -Raw | ConvertFrom-Json
    if ($runtime.version -ne $Version) { throw "Restarted runtime version $($runtime.version) does not match $Version" }
    if ($ExpectedError) {
      if ($runtime.updateError -notlike "*$ExpectedError*") { throw "Expected visible update error, got: $($runtime.updateError)" }
    } else {
      if ($runtime.updateError) { throw $runtime.updateError }
      if (-not $runtime.backendReady) { throw 'The updated app backend failed to start' }
    }
    Write-Output "Passed $Name : runtime=$($runtime.version)"
  } finally {
    Remove-Item Env:MOTOMIND_UPDATE_TEST_CONFIG -ErrorAction SilentlyContinue
    Remove-Item Env:MOTOMIND_SMOKE_PATH -ErrorAction SilentlyContinue
    @{
      runnerSession = (Get-Process -Id $PID).SessionId
      explorer = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | Select-Object Id, SessionId)
      launcher = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($appExe).ProductVersion
      ui = (Get-Content -LiteralPath (Join-Path $Directory 'resources\app\package.json') -Raw | ConvertFrom-Json).version
      processes = @(Get-CimInstance Win32_Process -Filter "Name = 'Motor Setup Tool.exe'" | Select-Object ProcessId, ExecutablePath, CommandLine)
    } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $caseDirectory 'installed-state.json')
    Copy-Item "$stateDirectory\update*" $caseDirectory -Force -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name = 'Motor Setup Tool.exe'" | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($testRoot, [System.StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}

# An update must stay in the installation it was started from.
Install-Previous '/allusers' $machineDirectory
Install-Previous '/currentuser' $userDirectory
Test-Update 'user-with-machine-copy' $userDirectory $Installer $Version
Test-Update 'machine-with-user-copy' $machineDirectory $Installer $Version

Install-Previous '/currentuser' $userDirectory
Test-Update 'custom-user-directory' $userDirectory $Installer $Version

# Exercise spaces, shell metacharacters, an apostrophe, and a non-ASCII path.
$unicodeSegment = [string][char]0xC5C5 + [char]0xB370 + [char]0xC774 + [char]0xD2B8
$specialDirectory = Join-Path $testRoot "O'Brien & $unicodeSegment App"
Install-Previous '/currentuser' $specialDirectory
Test-Update 'unicode-user-directory' $specialDirectory $Installer $Version

# A corrupt download must stay in the original app and show a useful error.
Test-Update 'checksum-failure' $specialDirectory $Installer '99.0.0' 'checksum mismatch'

# An installer must never force-stop a backend owned by another app/CLI.
$safetyDirectory = Join-Path $specialDirectory 'safety-test'
New-Item -ItemType Directory -Path $safetyDirectory -Force | Out-Null
$sourceFile = Join-Path $testRoot 'backend-stub.cs'
$stubFile = Join-Path $safetyDirectory 'motor-setup-tool.exe'
Set-Content $sourceFile 'public class Program { public static void Main() { System.Threading.Thread.Sleep(120000); } }'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe "/out:$stubFile" $sourceFile
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the harmless backend fixture' }
$stub = Start-Process -FilePath $stubFile -PassThru
try {
  $blocked = Start-Process -FilePath $Installer -ArgumentList "/S --updated /D=$specialDirectory" -PassThru
  if (-not $blocked.WaitForExit(45000)) { throw 'The installer did not stop after waiting for another backend' }
  if ($blocked.ExitCode -eq 0) { throw 'The installer accepted an update while another backend was running' }
  if ($stub.HasExited) { throw 'The installer terminated another motor backend' }
  Write-Output 'Passed active-backend protection: installer aborted without stopping the backend'
} finally {
  if (-not $stub.HasExited) { $stub.Kill(); $stub.WaitForExit() }
}

$nextVersion = Get-InstallerVersion $NextInstaller
Test-Update 'next-patch-user' $specialDirectory $NextInstaller $nextVersion -FromVersion $Version
Test-Update 'next-patch-machine' $machineDirectory $NextInstaller $nextVersion -FromVersion $Version
