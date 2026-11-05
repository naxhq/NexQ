; Plainer wording than Tauri's stock "kill it". {{product_name}} is filled in at run
; time by the CheckIfAppIsRunning macro. Included after Tauri's language file.
!pragma warning push
!pragma warning disable 6030
LangString appRunning ${LANG_ENGLISH} "{{product_name}} is still open. Close it, then run this installer again."
LangString appRunningOkKill ${LANG_ENGLISH} "{{product_name}} is open.$\nClick OK to close it and continue."
LangString failedToKillApp ${LANG_ENGLISH} "Couldn't close {{product_name}}. Please close it yourself, then try again."
LangString ^Extract ${LANG_ENGLISH} "Copying "
LangString ^Output ${LANG_ENGLISH} "Preparing "
!pragma warning pop
