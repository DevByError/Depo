; Depo NSIS installer hooks (wired in tauri.conf.json → bundle.windows.nsis.installerHooks).
; The installer already asks the user to close Depo itself, but an engine left running by an
; older version keeps depo-engine.exe locked, so the update would silently keep the old engine.

!macro DEPO_STOP_ENGINE
  nsExec::Exec 'taskkill /F /T /IM depo-engine.exe'
  Pop $0
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro DEPO_STOP_ENGINE
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro DEPO_STOP_ENGINE
!macroend
