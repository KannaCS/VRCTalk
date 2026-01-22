!macro NSIS_HOOK_PREINSTALL
  ; Check if VC++ Runtime is installed by looking for the DLL
  IfFileExists "$SYSDIR\msvcp140.dll" VCRedistInstalled VCRedistNotInstalled
  
  VCRedistNotInstalled:
    ; Download and install VC++ Redistributable from Microsoft
    DetailPrint "Downloading Visual C++ Runtime..."
    NSISdl::download "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$TEMP\vc_redist.x64.exe"
    Pop $0
    StrCmp $0 "success" VCDownloadSuccess VCDownloadFailed
    
  VCDownloadSuccess:
    DetailPrint "Installing Visual C++ Runtime..."
    ExecWait '"$TEMP\vc_redist.x64.exe" /install /quiet /norestart' $1
    DetailPrint "Visual C++ Runtime installation completed with exit code: $1"
    Delete "$TEMP\vc_redist.x64.exe"
    Goto VCRedistDone
    
  VCDownloadFailed:
    DetailPrint "Failed to download Visual C++ Runtime: $0"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Failed to download Visual C++ Runtime. Please install it manually from: https://aka.ms/vs/17/release/vc_redist.x64.exe"
    Goto VCRedistDone
    
  VCRedistInstalled:
    DetailPrint "Visual C++ Runtime already installed"
    
  VCRedistDone:
!macroend
