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
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null

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
  $handoff = Join-Path $caseDirectory 'handoff.json'
  try {
    $appRoot = Join-Path $Directory 'resources\app'
    foreach ($file in @('main.js', 'preload.js', 'updater.js', 'packaged-update-worker.js')) {
      Copy-Item (Join-Path $PSScriptRoot $file) (Join-Path $appRoot "electron\$file") -Force
    }
    & node -e 'require(process.argv[1]).copyRuntimeDependencies(process.argv[2])' (Join-Path $PSScriptRoot 'runtime-dependencies.js') $appRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not stage updater runtime dependencies' }
    $manifestFile = Join-Path $appRoot 'package.json'
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    $manifest.main = 'electron/packaged-update-worker.js'
    [System.IO.File]::WriteAllText($manifestFile, ($manifest | ConvertTo-Json))
    $configFile = Join-Path $caseDirectory 'request.json'
    [System.IO.File]::WriteAllText($configFile, (@{
      installer = $Setup; version = $ExpectedVersion; directory = $stateDirectory
      screenshot = $screenshot; handoff = $handoff; badChecksum = [bool]$ExpectedError
    } | ConvertTo-Json))
    $env:MOTOMIND_UPDATE_TEST_CONFIG = $configFile
    # Launch a GUI app as Explorer would, without a Node console parent.
    $running = Start-Process -FilePath $appExe -WorkingDirectory $Directory -PassThru
    if (-not $running.WaitForExit(45000)) { throw 'The packaged app did not complete its update handoff' }
    if ($running.ExitCode -ne 0) { throw "The packaged app update handoff failed ($($running.ExitCode))" }
    $source = Get-Content -LiteralPath $handoff -Raw | ConvertFrom-Json
    if ($ExpectedError) {
      if (-not $source.rejected) { throw 'The corrupt update was not rejected' }
    } elseif (-not $source.electron -or $source.target -ne $ExpectedVersion -or $source.updater -ne 'NsisUpdater') {
      throw 'The update did not use electron-updater from the packaged Electron app'
    }
    if (-not $ExpectedError) {
      # Hosted runners have no logged-on Explorer shell for NSIS's
      # ExecShellAsUser restart. Wait for the real installer to finish, then
      # explicitly launch the installed GUI to verify its runtime and backend.
      $installDeadline = (Get-Date).AddSeconds(60)
      $installed = $false
      while (-not $installed -and (Get-Date) -lt $installDeadline) {
        try {
          $launcher = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($appExe).ProductVersion
          $ui = (Get-Content -LiteralPath (Join-Path $Directory 'resources\app\package.json') -Raw | ConvertFrom-Json).version
          $installers = @(Get-CimInstance Win32_Process -Filter "Name = 'installer.exe'")
          $installed = ($launcher -eq $Version -or $launcher -eq "$Version.0") -and $ui -eq $Version -and $installers.Count -eq 0
        } catch { }
        if (-not $installed) { Start-Sleep -Milliseconds 200 }
      }
      if (-not $installed) { throw 'The NSIS update did not complete in the original installation directory' }
      Get-CimInstance Win32_Process -Filter "Name = 'Motor Setup Tool.exe'" | Where-Object {
        $_.ExecutablePath -ieq $appExe -and $_.CommandLine -notmatch '\s--type='
      } | ForEach-Object {
        $gui = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($gui -and (-not $gui.CloseMainWindow() -or -not $gui.WaitForExit(15000))) { throw 'The updated app did not close normally' }
      }
      $env:MOTOMIND_SMOKE_PATH = $screenshot
      $env:MOTOMIND_SMOKE_TAB = 'setup'
      $smoke = Start-Process -FilePath $appExe -WorkingDirectory $Directory -PassThru
      if (-not $smoke.WaitForExit(30000) -or $smoke.ExitCode -ne 0) { throw 'The updated app runtime smoke check failed' }
      Remove-Item Env:MOTOMIND_SMOKE_PATH -ErrorAction SilentlyContinue
      Remove-Item Env:MOTOMIND_SMOKE_TAB -ErrorAction SilentlyContinue
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
      if (-not $runtime.settingsOpen) { throw 'The failed update was not shown in Settings on restart' }
    } else {
      if ($runtime.updateError) { throw $runtime.updateError }
      $actual = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($appExe).ProductVersion
      if ($actual -ne $Version -and $actual -ne "$Version.0") { throw "Launcher version $actual does not match $Version" }
      if (Test-Path (Join-Path $stateDirectory 'pending-update.json')) { throw 'The restarted app did not verify its pending update' }
    }
    Write-Output "Passed $Name : runtime=$($runtime.version)"
  } finally {
    Remove-Item Env:MOTOMIND_UPDATE_TEST_CONFIG -ErrorAction SilentlyContinue
    Remove-Item Env:MOTOMIND_SMOKE_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:MOTOMIND_SMOKE_TAB -ErrorAction SilentlyContinue
    @{
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

# A bare /S chooses the machine installation when both scopes are registered,
# even when the update was requested from the user installation.
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
Test-Update 'checksum-failure' $userDirectory $Installer '99.0.0' 'checksum mismatch'
