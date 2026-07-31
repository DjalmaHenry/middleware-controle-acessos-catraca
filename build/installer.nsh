!macro customInit
  ; Encerra uma versão residente antes que o instalador substitua os binários.
  nsExec::ExecToLog 'taskkill.exe /F /T /IM "Ponte ID.exe"'
  Sleep 1000
!macroend
