param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$AppExe,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

$ErrorActionPreference = 'Stop'
try {
  Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode)."
  }
  if (-not (Test-Path -LiteralPath $AppExe)) {
    throw 'The installed app was not found after setup.'
  }
  $installedVersion = (Get-Item -LiteralPath $AppExe).VersionInfo.ProductVersion
  if ($installedVersion -ne $ExpectedVersion -and $installedVersion -ne "$ExpectedVersion.0") {
    throw "Installed version is $installedVersion; expected $ExpectedVersion."
  }
  Remove-Item -LiteralPath $ResultFile -Force -ErrorAction SilentlyContinue
} catch {
  [System.IO.File]::WriteAllText($ResultFile, "Update failed: $($_.Exception.Message)")
} finally {
  if (Test-Path -LiteralPath $AppExe) {
    Start-Process -FilePath $AppExe
  }
}
