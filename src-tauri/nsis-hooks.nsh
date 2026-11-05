; NexQ NSIS installer hooks
; Where the installer template (nsis/installer.nsi) finds the rest of its files
!define NEXQ_NSIS_DIR "${__FILEDIR__}\nsis"

; Installs Visual C++ 2015-2022 Redistributable if not present (first install only)

!macro NSIS_HOOK_PREINSTALL
  ; Updates (NexQ already installed) skip this: the app ships app-local runtime
  ; DLLs since v2.21.1, and a passive update must never block on a MessageBox.
  ${If} ${FileExists} "$INSTDIR\nexq.exe"
    DetailPrint "Visual C++ Runtime: skipped (update)"
    Goto vcredist_done
  ${EndIf}

  ; Check if Visual C++ 2015-2022 Redistributable (x64) is already installed
  ReadRegDWord $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"

  ${If} $0 == 1
    DetailPrint "Visual C++ Runtime: already installed"
    Goto vcredist_done
  ${EndIf}

  DetailPrint "Downloading Visual C++ Runtime..."
  Delete "$TEMP\vc_redist.x64.exe"

  NSISdl::download "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$TEMP\vc_redist.x64.exe"
  Pop $0

  ${If} $0 == "success"
    DetailPrint "Installing Visual C++ Runtime..."
    ExecWait '"$TEMP\vc_redist.x64.exe" /install /quiet /norestart' $1
    Delete "$TEMP\vc_redist.x64.exe"
  ${Else}
    MessageBox MB_ICONEXCLAMATION "Could not download Visual C++ Runtime.$\nPlease install it manually from:$\nhttps://aka.ms/vs/17/release/vc_redist.x64.exe"
  ${EndIf}

  vcredist_done:
!macroend
