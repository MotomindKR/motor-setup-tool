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
