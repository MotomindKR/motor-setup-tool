; electron-builder's supported customInit hook. Keep an update in the scope
; registered for the /D directory supplied by NsisUpdater.installDirectory.
; Without this, a silent user update can choose the system installation when
; both scopes are registered and uninstall the wrong copy.
!macro customInit
  ${if} ${isUpdated}
    ; initMultiUser has already applied /D and normalized NSIS path quoting.
    StrCpy $R0 $INSTDIR
    ${if} $R0 != ""
      ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $R2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${if} $R0 == $R1
        StrCpy $hasPerMachineInstallation "0"
        StrCpy $hasPerUserInstallation "1"
        !insertmacro setInstallModePerUser
      ${elseif} $R0 == $R2
        StrCpy $hasPerMachineInstallation "1"
        StrCpy $hasPerUserInstallation "0"
        !insertmacro setInstallModePerAllUsers
      ${else}
        Abort "The update directory does not match an installed copy. Run the installer manually."
      ${endif}
    ${endif}
  ${endif}
!macroend

; The default NSIS check can force-stop processes. A motor backend may be
; calibrating or flashing firmware, so wait for normal shutdown and abort
; rather than terminating another app instance or a CLI motor operation.
!macro customCheckAppRunning
  StrCpy $R3 0
  ${Do}
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${nsProcess::FindProcess} "motor-setup-tool.exe" $R1
    ${If} $R0 == 603
    ${AndIf} $R1 == 603
      ${Break}
    ${EndIf}
    ${If} $R3 >= 150
      Abort "Close other app windows and stop motor operations before updating."
    ${EndIf}
    IntOp $R3 $R3 + 1
    Sleep 200
  ${Loop}
!macroend
