; NexQ's installer screens, drawn with plain Win32 controls so no extra plugin
; ships in the installer. installer.nsi includes this after its Var declarations.
;
; One layout carries through every screen: the version number, the release's
; waveform, what's new, and a plate of facts about the build. Updates show only
; the progress screen, so that's the one to protect.
;
; The waveform is a real progress bar clipped to the wave's shape with a window
; region, so it draws itself. Nothing here may run NSIS code on the UI thread during
; the install: the engine isn't thread safe, which rules out timers on the progress
; screen. NSIS's own progress stands still while a big file unpacks, so the wave
; pulses then (the control's built-in marquee) and the status line under it shows
; the real percent. If an install stops short, the status line says why and the
; title bar's X, disabled until then, is the way out.

!include "nsDialogs.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"
!include "${NEXQ_NSIS_DIR}\release-info.nsh"

!if "${NQ_INFO_VERSION}" != "${VERSION}"
  !error "release-info.nsh describes ${NQ_INFO_VERSION}, but this build is ${VERSION}. Run: node scripts/nsis-release-info.mjs"
!endif

; Layout, in pixels at 100% scale
!define NQ_W 760
!define NQ_H 548
!define NQ_LEFT 40
!define NQ_WIDTH 680
!define NQ_BRAND_Y 26
!define NQ_KICKER_Y 80
!define NQ_HERO_Y 96
!define NQ_HERO_H 84
!define NQ_WAVE_Y 192
!define NQ_WAVE_H 60
!define NQ_STATUS_Y 258
!define NQ_INFO_Y 296
!define NQ_PLATE_X 496
!define NQ_PLATE_VALUE_X 572
!define NQ_ACTION_Y 484
!define NQ_ACTION_H 40
!define NQ_BUTTON_X 500
!define NQ_BUTTON_W 220
!define NQ_FOLDER_Y 495
!define NQ_WAVE_BARS 72

; Colors from the app's dark theme (src/index.css), as RRGGBB for SetCtlColors
!define NQ_BG 0A0F1A
!define NQ_TEXT EEF1F6
!define NQ_TEXT2 A3AEBF
!define NQ_TEXT3 667286
!define NQ_ACCENT_TEXT 6AA1F9
!define NQ_SUCCESS 34D399
!define NQ_WARNING F5A524
!define NQ_DANGER_TEXT F0777B
; The same colors as COLORREF (0xBBGGRR), for the Win32 calls
!define NQ_BG_REF 0x1A0F0A
!define NQ_LINE_REF 0x33261E
!define NQ_TEXT2_REF 0xBFAEA3
!define NQ_ACCENT_REF 0xF6823B
!define NQ_ACCENT_HOVER_REF 0xF8975C
!define NQ_SLATE_REF 0x86726A
!define NQ_DANGER_REF 0x413CDC
!define NQ_DANGER_HOVER_REF 0x5F5AEC
!define NQ_WAVE_EMPTY_REF 0x37291F

; Win32 values the NSIS headers don't all define
!define /ifndef NQ_PBM_SETPOS 0x0402
!define /ifndef NQ_PBM_SETBARCOLOR 0x0409
!define /ifndef NQ_PBM_SETBKCOLOR 0x2001
!define /ifndef NQ_PBS_SMOOTH 0x01
; Label styles: no & shortcuts, and clicks reach OnClick handlers
!define NQ_STATIC 0x50000180
!define NQ_STATIC_RIGHT 0x50000182
!define NQ_STATIC_BUTTON 0x50000381
; Shows a bitmap, and clicks reach OnClick handlers
!define NQ_STATIC_IMAGE 0x5000010E
; One line, shortening the middle of a long path
!define NQ_STATIC_PATH 0x5000C180

Var NqDpi
Var NqPage
Var NqUseDialogs
Var NqFontHero
Var NqFontBrand
Var NqFontBody
Var NqFontBold
Var NqFontSmall
Var NqFontButton
Var NqWave
Var NqFill
Var NqPrimary
Var NqPrimaryText
Var NqPrimaryBmp
Var NqPrimaryBmpHover
Var NqPrimaryHover
Var NqPrimaryDanger
Var NqNoteY
Var NqPrevious
Var NqCompare
Var NqWixKey
Var NqUninstallChosen
Var NqKicker
Var NqFolderLabel
Var NqShortcutCheck
Var NqRunOnClose
Var NqStatus

!macro NqPx OUT VALUE
  IntOp ${OUT} ${VALUE} * $NqDpi
  IntOp ${OUT} ${OUT} / 96
!macroend

; A label on the current page. FG and BG are RRGGBB.
!macro NqLabel UN OUT CLASS STYLE X Y W H TEXT FONT FG BG
  StrCpy $R0 "${CLASS}"
  StrCpy $R1 ${X}
  StrCpy $R2 ${Y}
  StrCpy $R3 ${W}
  StrCpy $R4 ${H}
  StrCpy $R5 "${TEXT}"
  StrCpy $R6 ${STYLE}
  Call ${UN}NqCreate
  Pop ${OUT}
  SendMessage ${OUT} ${WM_SETFONT} ${FONT} 1
  SetCtlColors ${OUT} ${FG} ${BG}
!macroend

!macro NqText UN OUT X Y W H TEXT FONT FG
  !insertmacro NqLabel "${UN}" ${OUT} STATIC ${NQ_STATIC} ${X} ${Y} ${W} ${H} "${TEXT}" ${FONT} ${FG} ${NQ_BG}
!macroend

; One waveform bar, from release-info.nsh. $R8 counts the bars.
!macro NqBar UN HEIGHT
  StrCpy $R9 ${HEIGHT}
  Call ${UN}NqAddBar
!macroend

; One row of "what's new", from release-info.nsh.
!macro NqNote TAG TEXT ROWS
  Push ${ROWS}
  Push "${TEXT}"
  Push "${TAG}"
  Call NqPaintNote
!macroend

; Everything shared by the installer and the uninstaller.
!macro NQ_UI_FUNCS UN

; Fit the window to the design, hide the stock chrome, color the title bar.
Function ${UN}NqGuiInit
  System::Call 'user32::GetDpiForSystem() i .r0'
  ${If} $0 < 96
    StrCpy $0 96
  ${EndIf}
  StrCpy $NqDpi $0

  ; Scale down rather than run off a small screen.
  System::Call 'user32::GetSystemMetrics(i 17) i .r1'
  !insertmacro NqPx $2 ${NQ_H}
  ${If} $2 > $1
    IntOp $NqDpi $1 * 96
    IntOp $NqDpi $NqDpi / ${NQ_H}
  ${EndIf}

  !insertmacro NqPx $2 ${NQ_W}
  !insertmacro NqPx $3 ${NQ_H}
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i .r4'
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i .r5'
  System::Call '*(i 0, i 0, i r2, i r3) p .r6'
  System::Call 'user32::AdjustWindowRectEx(p r6, i r4, i 0, i r5)'
  System::Call '*$6(i .r7, i .r8, i .r9, i .R9)'
  System::Free $6
  IntOp $9 $9 - $7
  IntOp $R9 $R9 - $8
  System::Call 'user32::GetSystemMetrics(i 16) i .r7'
  IntOp $7 $7 - $9
  IntOp $7 $7 / 2
  IntOp $8 $1 - $R9
  IntOp $8 $8 / 2
  ${If} $8 < 0
    StrCpy $8 0
  ${EndIf}
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r7, i r8, i r9, i R9, i 0x14)'

  ; A dark title bar in the page's own color, so it reads as one surface
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${NQ_BG_REF}, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, *i ${NQ_LINE_REF}, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i ${NQ_TEXT2_REF}, i 4)'
  SetCtlColors $HWNDPARENT "" ${NQ_BG}

  ; Stock header, branding text and separators
  !insertmacro NqHideControl 1034
  !insertmacro NqHideControl 1035
  !insertmacro NqHideControl 1036
  !insertmacro NqHideControl 1037
  !insertmacro NqHideControl 1038
  !insertmacro NqHideControl 1039
  !insertmacro NqHideControl 1028
  !insertmacro NqHideControl 1256
  !insertmacro NqHideControl 1045

  ; Pages fill the window. The real buttons stay in play off screen, so Enter,
  ; Esc and screen readers keep working; what's on screen acts through them.
  GetDlgItem $0 $HWNDPARENT 1018
  System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i 0, i r2, i r3, i 0x14)'
  !insertmacro NqMoveAway 1
  !insertmacro NqMoveAway 2
  !insertmacro NqMoveAway 3

  ; Fonts
  ${If} ${FileExists} "$FONTS\SegUIVar.ttf"
    StrCpy $0 "Segoe UI Variable Display"
    StrCpy $1 "Segoe UI Variable Text"
  ${Else}
    StrCpy $0 "Segoe UI"
    StrCpy $1 "Segoe UI"
  ${EndIf}
  !insertmacro NqMakeFont $NqFontHero $0 76 600 4
  !insertmacro NqMakeFont $NqFontBrand $0 19 600 5
  !insertmacro NqMakeFont $NqFontBody $1 14 400 5
  !insertmacro NqMakeFont $NqFontBold $1 13 600 5
  !insertmacro NqMakeFont $NqFontSmall $1 13 400 5
  !insertmacro NqMakeFont $NqFontButton $1 14 600 5
FunctionEnd

; Makes a control. $R0 class, $R1-$R4 rect at 100%, $R5 text, $R6 style. Pushes the handle.
Function ${UN}NqCreate
  !insertmacro NqPx $R1 $R1
  !insertmacro NqPx $R2 $R2
  !insertmacro NqPx $R3 $R3
  !insertmacro NqPx $R4 $R4
  ${If} $NqUseDialogs = 1
    nsDialogs::CreateControl "$R0" $R6 0 $R1 $R2 $R3 $R4 "$R5"
  ${Else}
    System::Call 'user32::CreateWindowExW(i 0, w R0, w R5, i R6, i R1, i R2, i R3, i R4, p $NqPage, p 0, p 0, p 0) p .s'
  ${EndIf}
FunctionEnd

; Adds one bar to the region in $R7. $R8 is its index, $R9 its height in percent.
Function ${UN}NqAddBar
  ; x
  IntOp $0 $R8 * ${NQ_WIDTH}
  IntOp $0 $0 / ${NQ_WAVE_BARS}
  !insertmacro NqPx $0 $0
  ; Unthemed progress bars draw a light edge on their first pixels.
  IntOp $0 $0 + 2
  ; width: a bar and a gap in every step
  IntOp $1 ${NQ_WIDTH} * 62
  IntOp $1 $1 / 100
  IntOp $1 $1 / ${NQ_WAVE_BARS}
  !insertmacro NqPx $1 $1
  ${If} $1 < 2
    StrCpy $1 2
  ${EndIf}
  ; height, centered
  !insertmacro NqPx $2 ${NQ_WAVE_H}
  StrCpy $3 $2
  IntOp $2 $2 * $R9
  IntOp $2 $2 / 100
  ${If} $2 < $1
    StrCpy $2 $1
  ${EndIf}
  IntOp $3 $3 - $2
  IntOp $3 $3 / 2
  ; corners
  IntOp $4 $0 + $1
  IntOp $4 $4 + 1
  IntOp $5 $3 + $2
  IntOp $5 $5 + 1
  System::Call 'gdi32::CreateRoundRectRgn(i r0, i r3, i r4, i r5, i r1, i r1) p .r6'
  System::Call 'gdi32::CombineRgn(p R7, p R7, p r6, i 2)'
  System::Call 'gdi32::DeleteObject(p r6)'
  IntOp $R8 $R8 + 1
FunctionEnd

; Places a progress bar where the wave goes and clips it to the wave's shape.
; $0 is the bar, $1 its color.
Function ${UN}NqShapeWave
  StrCpy $NqWave $0
  System::Call 'uxtheme::SetWindowTheme(p $NqWave, w "", w "")'
  SendMessage $NqWave ${NQ_PBM_SETBARCOLOR} 0 $1
  SendMessage $NqWave ${NQ_PBM_SETBKCOLOR} 0 ${NQ_WAVE_EMPTY_REF}
  System::Call 'user32::SetWindowLongW(p $NqWave, i -20, i 0)'
  !insertmacro NqPx $2 ${NQ_LEFT}
  !insertmacro NqPx $3 ${NQ_WAVE_Y}
  !insertmacro NqPx $4 ${NQ_WIDTH}
  !insertmacro NqPx $5 ${NQ_WAVE_H}
  System::Call 'user32::SetWindowPos(p $NqWave, p 0, i r2, i r3, i r4, i r5, i 0x34)'

  System::Call 'gdi32::CreateRectRgn(i 0, i 0, i 0, i 0) p .R7'
  StrCpy $R8 0
  !insertmacro NQ_WAVE "${UN}"
  ; The window owns the region from here on.
  System::Call 'user32::SetWindowRgn(p $NqWave, p R7, i 1)'
FunctionEnd

; The top of every screen. $NqKicker is the line above the version.
Function ${UN}NqPaintBrand
  ; The installer's own icon, sized for this display
  !insertmacro NqPx $0 ${NQ_LEFT}
  !insertmacro NqPx $1 ${NQ_BRAND_Y}
  !insertmacro NqPx $2 30
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", p 0, i 0x50000003, i r0, i r1, i r2, i r2, p $NqPage, p 0, p 0, p 0) p .r3'
  System::Call 'kernel32::GetModuleHandleW(p 0) p .r4'
  System::Call 'user32::LoadImageW(p r4, i 103, i 1, i r2, i r2, i 0) p .r5'
  SendMessage $3 0x0170 $5 0
  SetCtlColors $3 "" ${NQ_BG}
  !insertmacro NqText "${UN}" $0 80 ${NQ_BRAND_Y} 200 30 "${PRODUCTNAME}" $NqFontBrand ${NQ_TEXT}
  System::Call 'user32::SetWindowLongW(p r0, i -16, i 0x50000380)'
  !insertmacro NqLabel "${UN}" $0 STATIC ${NQ_STATIC_RIGHT} 400 ${NQ_BRAND_Y} 320 30 "AI meeting assistant and interview copilot" $NqFontSmall ${NQ_TEXT3} ${NQ_BG}
  System::Call 'user32::SetWindowLongW(p r0, i -16, i 0x50000382)'
  !insertmacro NqText "${UN}" $0 ${NQ_LEFT} ${NQ_HERO_Y} ${NQ_WIDTH} ${NQ_HERO_H} "${VERSION}" $NqFontHero ${NQ_TEXT}
FunctionEnd

; A label over the version, in a color that says what kind of moment this is.
Function ${UN}NqKickerAccent
  !insertmacro NqText "${UN}" $0 ${NQ_LEFT} ${NQ_KICKER_Y} ${NQ_WIDTH} 18 "$NqKicker" $NqFontBold ${NQ_ACCENT_TEXT}
FunctionEnd
Function ${UN}NqKickerWarning
  !insertmacro NqText "${UN}" $0 ${NQ_LEFT} ${NQ_KICKER_Y} ${NQ_WIDTH} 18 "$NqKicker" $NqFontBold ${NQ_WARNING}
FunctionEnd
Function ${UN}NqKickerSuccess
  !insertmacro NqText "${UN}" $0 ${NQ_LEFT} ${NQ_KICKER_Y} ${NQ_WIDTH} 18 "$NqKicker" $NqFontBold ${NQ_SUCCESS}
FunctionEnd
Function ${UN}NqKickerDanger
  !insertmacro NqText "${UN}" $0 ${NQ_LEFT} ${NQ_KICKER_Y} ${NQ_WIDTH} 18 "$NqKicker" $NqFontBold ${NQ_DANGER_TEXT}
FunctionEnd

; Draws the main button into a bitmap and leaves it in $R9. $R0 is the color. It's
; drawn big and scaled down, which smooths the corners, then the text goes on top.
; (Static controls ignore window regions, and native buttons can't take a color.)
Function ${UN}NqDrawButton
  !insertmacro NqPx $0 ${NQ_BUTTON_W}
  !insertmacro NqPx $1 ${NQ_ACTION_H}
  !insertmacro NqPx $2 14
  IntOp $3 $0 * 4
  IntOp $4 $1 * 4
  IntOp $5 $2 * 4
  System::Call 'user32::GetDC(p 0) p .r6'

  ; The shape, four times too big
  System::Call 'gdi32::CreateCompatibleDC(p r6) p .r7'
  System::Call 'gdi32::CreateCompatibleBitmap(p r6, i r3, i r4) p .r8'
  System::Call 'gdi32::SelectObject(p r7, p r8) p .r9'
  System::Call 'gdi32::CreateSolidBrush(i ${NQ_BG_REF}) p .R1'
  System::Call '*(i 0, i 0, i r3, i r4) p .R2'
  System::Call 'user32::FillRect(p r7, p R2, p R1)'
  System::Free $R2
  System::Call 'gdi32::DeleteObject(p R1)'
  System::Call 'gdi32::CreateSolidBrush(i R0) p .R1'
  System::Call 'gdi32::CreatePen(i 0, i 1, i R0) p .R2'
  System::Call 'gdi32::SelectObject(p r7, p R1) p .R3'
  System::Call 'gdi32::SelectObject(p r7, p R2) p .R4'
  System::Call 'gdi32::RoundRect(p r7, i 0, i 0, i r3, i r4, i r5, i r5)'
  System::Call 'gdi32::SelectObject(p r7, p R3)'
  System::Call 'gdi32::SelectObject(p r7, p R4)'
  System::Call 'gdi32::DeleteObject(p R1)'
  System::Call 'gdi32::DeleteObject(p R2)'

  ; Scaled to size
  System::Call 'gdi32::CreateCompatibleDC(p r6) p .R1'
  System::Call 'gdi32::CreateCompatibleBitmap(p r6, i r0, i r1) p .R9'
  System::Call 'gdi32::SelectObject(p R1, p R9) p .R5'
  System::Call 'gdi32::SetStretchBltMode(p R1, i 4)'
  System::Call 'gdi32::SetBrushOrgEx(p R1, i 0, i 0, p 0)'
  System::Call 'gdi32::StretchBlt(p R1, i 0, i 0, i r0, i r1, p r7, i 0, i 0, i r3, i r4, i 0x00CC0020)'

  ; The text
  System::Call 'gdi32::SelectObject(p R1, p $NqFontButton) p .R6'
  System::Call 'gdi32::SetBkMode(p R1, i 1)'
  System::Call 'gdi32::SetTextColor(p R1, i 0xFFFFFF)'
  System::Call '*(i 0, i 0, i r0, i r1) p .R8'
  System::Call 'user32::DrawTextW(p R1, w "$NqPrimaryText", i -1, p R8, i 0x25)'
  System::Free $R8

  System::Call 'gdi32::SelectObject(p R1, p R6)'
  System::Call 'gdi32::SelectObject(p R1, p R5)'
  System::Call 'gdi32::DeleteDC(p R1)'
  System::Call 'gdi32::SelectObject(p r7, p r9)'
  System::Call 'gdi32::DeleteObject(p r8)'
  System::Call 'gdi32::DeleteDC(p r7)'
  System::Call 'user32::ReleaseDC(p 0, p r6)'
FunctionEnd

; The main action. $R5 is its text, $NqPrimaryDanger its color.
Function ${UN}NqPaintPrimary
  StrCpy $NqPrimaryHover 0
  StrCpy $NqPrimaryText "$R5"
  ${If} $NqPrimaryDanger = 1
    StrCpy $R0 ${NQ_DANGER_REF}
    Call ${UN}NqDrawButton
    StrCpy $NqPrimaryBmp $R9
    StrCpy $R0 ${NQ_DANGER_HOVER_REF}
    Call ${UN}NqDrawButton
    StrCpy $NqPrimaryBmpHover $R9
  ${Else}
    StrCpy $R0 ${NQ_ACCENT_REF}
    Call ${UN}NqDrawButton
    StrCpy $NqPrimaryBmp $R9
    StrCpy $R0 ${NQ_ACCENT_HOVER_REF}
    Call ${UN}NqDrawButton
    StrCpy $NqPrimaryBmpHover $R9
  ${EndIf}
  !insertmacro NqLabel "${UN}" $NqPrimary STATIC ${NQ_STATIC_IMAGE} ${NQ_BUTTON_X} ${NQ_ACTION_Y} ${NQ_BUTTON_W} ${NQ_ACTION_H} "" $NqFontButton FFFFFF ${NQ_BG}
  SendMessage $NqPrimary 0x0172 0 $NqPrimaryBmp
  ; A bitmap has no name, so screen readers get it from the real Next button (off
  ; screen, and what Enter presses).
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$NqPrimaryText"
FunctionEnd

; Runs on custom pages only: the waveform's entrance, and the action's hover.
Function ${UN}NqTick
  ${If} $NqFill < 100
    IntOp $NqFill $NqFill + 5
    IntOp $0 100 - $NqFill
    IntOp $0 $0 * $0
    IntOp $0 $0 / 100
    IntOp $0 100 - $0
    SendMessage $NqWave ${NQ_PBM_SETPOS} $0 0
  ${EndIf}

  System::Call 'user32::GetCursorPos(*l .r1)'
  System::Call 'user32::WindowFromPoint(l r1) p .r2'
  ${If} $2 == $NqPrimary
    StrCpy $3 1
  ${Else}
    StrCpy $3 0
  ${EndIf}
  ${If} $3 <> $NqPrimaryHover
    StrCpy $NqPrimaryHover $3
    ${If} $3 = 1
      SendMessage $NqPrimary 0x0172 0 $NqPrimaryBmpHover
    ${Else}
      SendMessage $NqPrimary 0x0172 0 $NqPrimaryBmp
    ${EndIf}
  ${EndIf}
FunctionEnd

; Starts a custom page: an empty surface with the wave drawn in.
Function ${UN}NqBeginPage
  StrCpy $NqUseDialogs 1
  nsDialogs::Create 1018
  Pop $NqPage
  SetCtlColors $NqPage "" ${NQ_BG}
  Call ${UN}NqPaintBrand
  !insertmacro NqLabel "${UN}" $0 msctls_progress32 0x50000001 ${NQ_LEFT} ${NQ_WAVE_Y} ${NQ_WIDTH} ${NQ_WAVE_H} "" $NqFontBody FFFFFF ${NQ_BG}
  StrCpy $1 ${NQ_ACCENT_REF}
  Call ${UN}NqShapeWave
FunctionEnd

; Plays the waveform's entrance unless the person turned animations off.
Function ${UN}NqStartReveal
  System::Call 'user32::SystemParametersInfoW(i 0x1042, i 0, *i .r0, i 0)'
  ${If} $0 = 0
    StrCpy $NqFill 100
    SendMessage $NqWave ${NQ_PBM_SETPOS} 100 0
  ${Else}
    StrCpy $NqFill 0
  ${EndIf}
  ${NSD_CreateTimer} ${UN}NqTick 16
FunctionEnd

Function ${UN}NqEndPage
  ${NSD_KillTimer} ${UN}NqTick
FunctionEnd

Function ${UN}NqGoNext
  Pop $0
  SendMessage $HWNDPARENT 0x408 1 0
FunctionEnd

Function ${UN}NqQuit
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd

; Lays out the install progress screen around the page's own controls.
; $R5 is the status line's color choice: 1 for the uninstaller's quieter fill.
Function ${UN}NqPaintProgress
  StrCpy $NqUseDialogs 0
  FindWindow $NqPage "#32770" "" $HWNDPARENT
  SetCtlColors $NqPage "" ${NQ_BG}
  ; NSIS keeps a built-in page at its original size
  !insertmacro NqPx $0 ${NQ_W}
  !insertmacro NqPx $1 ${NQ_H}
  System::Call 'user32::SetWindowPos(p $NqPage, p 0, i 0, i 0, i r0, i r1, i 0x14)'

  ; Stock caption, log and "Show details"
  GetDlgItem $0 $NqPage 1027
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $NqPage 1016
  ShowWindow $0 ${SW_HIDE}

  ; NSIS keeps writing the live status here, including extraction percent
  GetDlgItem $NqStatus $NqPage 1006
  SetCtlColors $NqStatus ${NQ_TEXT2} ${NQ_BG}
  SendMessage $NqStatus ${WM_SETFONT} $NqFontSmall 1
  !insertmacro NqPx $0 ${NQ_LEFT}
  !insertmacro NqPx $1 ${NQ_STATUS_Y}
  !insertmacro NqPx $2 ${NQ_WIDTH}
  !insertmacro NqPx $3 18
  System::Call 'user32::SetWindowPos(p $NqStatus, p 0, i r0, i r1, i r2, i r3, i 0x14)'

  Call ${UN}NqPaintBrand
  GetDlgItem $0 $NqPage 1004
FunctionEnd

!macroend

; Called from the install section, on its own thread, around slow steps.
!macro NqPulseStart
  ${IfNot} ${Silent}
    System::Call 'user32::GetWindowLongW(p $NqWave, i -16) i .r0'
    IntOp $0 $0 | 0x08
    System::Call 'user32::SetWindowLongW(p $NqWave, i -16, i r0)'
    SendMessage $NqWave 0x040A 1 24
  ${EndIf}
!macroend

!macro NqPulseStop
  ${IfNot} ${Silent}
    SendMessage $NqWave 0x040A 0 0
    System::Call 'user32::GetWindowLongW(p $NqWave, i -16) i .r0'
    IntOp $0 $0 & 0xFFFFFFF7
    System::Call 'user32::SetWindowLongW(p $NqWave, i -16, i r0)'
  ${EndIf}
!macroend

!macro NqHideControl ID
  GetDlgItem $0 $HWNDPARENT ${ID}
  ShowWindow $0 ${SW_HIDE}
!macroend

!macro NqMoveAway ID
  GetDlgItem $0 $HWNDPARENT ${ID}
  System::Call 'user32::SetWindowPos(p r0, p 0, i -400, i -400, i 80, i 24, i 0x15)'
!macroend

!macro NqMakeFont OUT FACE PX WEIGHT QUALITY
  !insertmacro NqPx $2 ${PX}
  IntOp $2 0 - $2
  System::Call 'gdi32::CreateFontW(i r2, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i ${QUALITY}, i 0, w "${FACE}") p .r3'
  StrCpy ${OUT} $3
!macroend

!insertmacro NQ_UI_FUNCS ""
!insertmacro NQ_UI_FUNCS "un."

; ── Installer screens ──────────────────────────────────────────────

; One row of "what's new"
Function NqPaintNote
  Pop $R7
  Pop $R8
  Pop $R9
  !insertmacro NqText "" $0 ${NQ_LEFT} $NqNoteY 48 20 "$R7" $NqFontBold ${NQ_ACCENT_TEXT}
  IntOp $1 $R9 * 19
  !insertmacro NqLabel "" $0 STATIC ${NQ_STATIC} 92 $NqNoteY 370 $1 "$R8" $NqFontBody ${NQ_TEXT} ${NQ_BG}
  IntOp $1 $R9 * 19
  IntOp $NqNoteY $NqNoteY + $1
  IntOp $NqNoteY $NqNoteY + 10
FunctionEnd

Function NqPaintNotes
  !insertmacro NqText "" $0 ${NQ_LEFT} ${NQ_INFO_Y} 400 18 "What's new" $NqFontSmall ${NQ_TEXT3}
  IntOp $NqNoteY ${NQ_INFO_Y} + 26
  !if ${NQ_NOTES_TOTAL} = 0
    !insertmacro NqLabel "" $0 STATIC ${NQ_STATIC} ${NQ_LEFT} $NqNoteY 420 38 "Improvements across NexQ. The release notes on GitHub have the details." $NqFontBody ${NQ_TEXT2} ${NQ_BG}
  !else
    !insertmacro NQ_RELEASE_NOTES
  !endif
  !if ${NQ_NOTES_MORE} > 0
    !insertmacro NqText "" $0 92 $NqNoteY 370 18 "and ${NQ_NOTES_MORE} more" $NqFontSmall ${NQ_TEXT3}
  !endif
FunctionEnd

!macro NqPlateRow Y LABEL VALUE
  !insertmacro NqText "" $0 ${NQ_PLATE_X} ${Y} 72 18 "${LABEL}" $NqFontSmall ${NQ_TEXT3}
  !insertmacro NqText "" $0 ${NQ_PLATE_VALUE_X} ${Y} 148 18 "${VALUE}" $NqFontSmall ${NQ_TEXT2}
!macroend

; Facts about this build, like the plate on an instrument.
Function NqPaintPlate
  IntOp $0 ${ESTIMATEDSIZE} / 1024
  StrCpy $R9 "$0 MB"
  !define /math NQ_PLATE_ROW2 ${NQ_INFO_Y} + 24
  !define /math NQ_PLATE_ROW3 ${NQ_INFO_Y} + 48
  !define /math NQ_PLATE_ROW4 ${NQ_INFO_Y} + 72
  !define /math NQ_PLATE_ROW5 ${NQ_INFO_Y} + 96
  !insertmacro NqPlateRow ${NQ_INFO_Y} "Released" "${NQ_RELEASED}"
  !insertmacro NqPlateRow ${NQ_PLATE_ROW2} "Build" "${NQ_BUILD}"
  !insertmacro NqPlateRow ${NQ_PLATE_ROW3} "Size" "$R9"
  !insertmacro NqPlateRow ${NQ_PLATE_ROW4} "For" "Windows ${ARCH}"
  ${If} $NqPrevious != ""
  ${AndIf} $NqCompare != 0
    !insertmacro NqPlateRow ${NQ_PLATE_ROW5} "Replaces" "$NqPrevious"
  ${EndIf}
FunctionEnd

; Is NexQ already here, and which way does this installer take it?
Function NqDetectInstalled
  StrCpy $NqCompare ""
  StrCpy $NqPrevious ""
  Call FindWixInstall
  ${If} $R6 != ""
    StrCpy $WixMode 1
    StrCpy $NqWixKey $R6
    ReadRegStr $NqPrevious HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
    ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
    ${If} "$R0$R1" == ""
      Return
    ${EndIf}
    ReadRegStr $NqPrevious SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  nsis_tauri_utils::SemverCompare "${VERSION}" $NqPrevious
  Pop $NqCompare
FunctionEnd

Function NqChooseFolder
  Pop $0
  nsDialogs::SelectFolderDialog "Install NexQ in" "$INSTDIR"
  Pop $0
  ${If} $0 != error
  ${AndIf} $0 != ""
    ${GetFileName} $0 $1
    ${If} $1 == "${PRODUCTNAME}"
      StrCpy $INSTDIR $0
    ${Else}
      StrCpy $INSTDIR "$0\${PRODUCTNAME}"
    ${EndIf}
    SendMessage $NqFolderLabel ${WM_SETTEXT} 0 "STR:$INSTDIR"
  ${EndIf}
FunctionEnd

Function NqUninstallClicked
  Pop $0
  StrCpy $NqUninstallChosen 1
  SendMessage $HWNDPARENT 0x408 1 0
FunctionEnd

; The first screen: what's being installed, and the one decision that's left.
Function NqHomeShow
  Call NqDetectInstalled

  ; Passive installs and updates never see this screen.
  ${If} $PassiveMode = 1
    Call NqApplyChoice
    Abort
  ${EndIf}

  StrCpy $NqPrimaryDanger 0
  Call NqBeginPage

  ${If} $NqCompare == ""
    StrCpy $NqKicker "Ready to install"
    Call NqKickerAccent
    StrCpy $R5 "Install ${PRODUCTNAME}"
  ${ElseIf} $NqCompare = 1
    ${If} $NqPrevious == ""
      StrCpy $NqKicker "Ready to update"
    ${Else}
      StrCpy $NqKicker "Update from $NqPrevious"
    ${EndIf}
    Call NqKickerAccent
    StrCpy $R5 "Update ${PRODUCTNAME}"
  ${ElseIf} $NqCompare = 0
    StrCpy $NqKicker "Already installed"
    Call NqKickerAccent
    StrCpy $R5 "Reinstall"
  ${Else}
    StrCpy $NqKicker "Older than your $NqPrevious"
    Call NqKickerWarning
    StrCpy $R5 "Install older version"
  ${EndIf}
  Call NqPaintPrimary
  ${NSD_OnClick} $NqPrimary NqGoNext

  Call NqPaintNotes
  Call NqPaintPlate

  ; Where it goes. The folder only changes on a first install.
  !insertmacro NqText "" $0 ${NQ_LEFT} ${NQ_FOLDER_Y} 50 18 "Folder" $NqFontSmall ${NQ_TEXT3}
  ${If} $NqCompare == ""
    !insertmacro NqLabel "" $NqFolderLabel STATIC ${NQ_STATIC_PATH} 92 ${NQ_FOLDER_Y} 240 18 "$INSTDIR" $NqFontSmall ${NQ_TEXT2} ${NQ_BG}
    !insertmacro NqText "" $0 340 ${NQ_FOLDER_Y} 56 18 "Change" $NqFontBold ${NQ_ACCENT_TEXT}
    ${NSD_OnClick} $0 NqChooseFolder
  ${ElseIf} $NqCompare = 0
    !insertmacro NqLabel "" $NqFolderLabel STATIC ${NQ_STATIC_PATH} 92 ${NQ_FOLDER_Y} 180 18 "$INSTDIR" $NqFontSmall ${NQ_TEXT2} ${NQ_BG}
    !insertmacro NqText "" $0 280 ${NQ_FOLDER_Y} 116 18 "Uninstall instead" $NqFontBold ${NQ_TEXT2}
    ${NSD_OnClick} $0 NqUninstallClicked
  ${Else}
    !insertmacro NqLabel "" $NqFolderLabel STATIC ${NQ_STATIC_PATH} 92 ${NQ_FOLDER_Y} 300 18 "$INSTDIR" $NqFontSmall ${NQ_TEXT2} ${NQ_BG}
  ${EndIf}

  !insertmacro NqLabel "" $0 STATIC ${NQ_STATIC_BUTTON} 400 ${NQ_ACTION_Y} 88 ${NQ_ACTION_H} "Cancel" $NqFontButton ${NQ_TEXT2} ${NQ_BG}
  ${NSD_OnClick} $0 NqQuit

  Call NqStartReveal
  nsDialogs::Show
  Call NqEndPage
FunctionEnd

; Same result as Tauri's reinstall page, without asking people to choose whether
; to uninstall first: an upgrade or downgrade replaces the files in place, the
; same way an automatic update does.
Function NqApplyChoice
  ${If} $WixMode = 1
    Goto uninstall_first
  ${EndIf}

  ${If} $NqUninstallChosen = 1
    Goto uninstall_first
  ${EndIf}

  ${If} $PassiveMode <> 1
  ${AndIf} $NqCompare != ""
  ${AndIf} $NqCompare <> 0
    StrCpy $UpdateMode 1
  ${EndIf}
  Return

  uninstall_first:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$NqWixKey" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        StrCpy $NqUninstallChosen 0
        Abort
      ${EndIf}

      ${If} $0 = 1
        StrCpy $NqUninstallChosen 0
        Abort
      ${EndIf}

      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      StrCpy $NqUninstallChosen 0
      Abort
    ${EndIf}

    ; The NSIS uninstaller was run in place (`_?=`), so it cannot delete itself
    ; and the install directory, clean them up here once the uninstall succeeded
    ${If} $WixMode = 0
    ${AndIf} $4 != ""
      Delete "$4\uninstall.exe"
      RMDir "$4"
    ${EndIf}

    ; They asked to uninstall, not to install again.
    ${If} $NqUninstallChosen = 1
      Quit
    ${EndIf}
FunctionEnd

Function NqHomeLeave
  Call NqEndPage
  Call NqApplyChoice
FunctionEnd

Function NqProgressShow
  Call NqPaintProgress
  StrCpy $1 ${NQ_ACCENT_REF}
  Call NqShapeWave
  ${If} $NqCompare == ""
    StrCpy $NqKicker "Installing"
  ${ElseIf} $NqCompare = 1
    ${If} $NqPrevious == ""
      StrCpy $NqKicker "Updating"
    ${Else}
      StrCpy $NqKicker "Updating from $NqPrevious"
    ${EndIf}
  ${ElseIf} $NqCompare = 0
    StrCpy $NqKicker "Reinstalling"
  ${Else}
    StrCpy $NqKicker "Installing the older version"
  ${EndIf}
  Call NqKickerAccent
  Call NqPaintNotes
  Call NqPaintPlate
FunctionEnd

Function NqJustClose
  Pop $0
  StrCpy $NqRunOnClose 0
  SendMessage $HWNDPARENT 0x408 1 0
FunctionEnd

; The last screen. Updates and passive installs reopen NexQ by themselves.
Function NqDoneShow
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}

  ; Enter presses the main action, so opening NexQ is the default. Close opts out.
  StrCpy $NqRunOnClose 1
  StrCpy $NqPrimaryDanger 0
  Call NqBeginPage
  StrCpy $NqKicker "Installed"
  Call NqKickerSuccess
  StrCpy $R5 "Open ${PRODUCTNAME}"
  Call NqPaintPrimary
  ${NSD_OnClick} $NqPrimary NqGoNext

  Call NqPaintNotes
  Call NqPaintPlate

  StrCpy $NqShortcutCheck 0
  ${If} $UpdateMode <> 1
    !insertmacro NqPx $1 ${NQ_LEFT}
    !insertmacro NqPx $2 492
    !insertmacro NqPx $3 15
    !insertmacro NqPx $4 24
    nsDialogs::CreateControl BUTTON 0x50010003 0 $1 $2 $3 $4 "$(createDesktop)"
    Pop $NqShortcutCheck
    System::Call 'uxtheme::SetWindowTheme(p $NqShortcutCheck, w "DarkMode_Explorer", p 0)'
    SetCtlColors $NqShortcutCheck "" ${NQ_BG}
    SendMessage $NqShortcutCheck ${BM_SETCHECK} ${BST_CHECKED} 0
    !insertmacro NqText "" $0 62 495 260 18 "$(createDesktop)" $NqFontBody ${NQ_TEXT2}
    ${NSD_OnClick} $0 NqToggleShortcut
  ${EndIf}

  !insertmacro NqLabel "" $0 STATIC ${NQ_STATIC_BUTTON} 400 ${NQ_ACTION_Y} 88 ${NQ_ACTION_H} "Close" $NqFontButton ${NQ_TEXT2} ${NQ_BG}
  ${NSD_OnClick} $0 NqJustClose

  ; The wave is already full: this is the same bar the progress screen just filled.
  StrCpy $NqFill 100
  SendMessage $NqWave ${NQ_PBM_SETPOS} 100 0
  ${NSD_CreateTimer} NqTick 16
  nsDialogs::Show
  Call NqEndPage
FunctionEnd

Function NqToggleShortcut
  Pop $0
  ${NSD_GetState} $NqShortcutCheck $1
  ${If} $1 = ${BST_CHECKED}
    SendMessage $NqShortcutCheck ${BM_SETCHECK} ${BST_UNCHECKED} 0
  ${Else}
    SendMessage $NqShortcutCheck ${BM_SETCHECK} ${BST_CHECKED} 0
  ${EndIf}
FunctionEnd

Function NqDoneLeave
  Call NqEndPage
  ${If} $NqShortcutCheck != 0
    ${NSD_GetState} $NqShortcutCheck $1
    ${If} $1 = ${BST_CHECKED}
      Call CreateOrUpdateDesktopShortcut
    ${EndIf}
  ${EndIf}
  ${If} $NqRunOnClose = 1
    Call RunMainBinary
  ${EndIf}
FunctionEnd

; ── Uninstaller screens ────────────────────────────────────────────

Function un.NqToggleDeleteData
  Pop $0
  ${NSD_GetState} $DeleteAppDataCheckbox $1
  ${If} $1 = ${BST_CHECKED}
    SendMessage $DeleteAppDataCheckbox ${BM_SETCHECK} ${BST_UNCHECKED} 0
  ${Else}
    SendMessage $DeleteAppDataCheckbox ${BM_SETCHECK} ${BST_CHECKED} 0
  ${EndIf}
FunctionEnd

Function un.NqConfirmShow
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}

  StrCpy $NqPrimaryDanger 1
  Call un.NqBeginPage
  SendMessage $NqWave ${NQ_PBM_SETBARCOLOR} 0 ${NQ_SLATE_REF}
  StrCpy $NqKicker "Uninstall"
  Call un.NqKickerDanger
  StrCpy $R5 "Uninstall ${PRODUCTNAME}"
  Call un.NqPaintPrimary
  ${NSD_OnClick} $NqPrimary un.NqGoNext

  !insertmacro NqLabel "un." $0 STATIC ${NQ_STATIC} ${NQ_LEFT} ${NQ_INFO_Y} 620 44 "This removes ${PRODUCTNAME} from this PC. Your meetings, recordings and settings stay, so reinstalling picks up where you left off." $NqFontBody ${NQ_TEXT} ${NQ_BG}
  !insertmacro NqText "un." $0 ${NQ_LEFT} 344 60 18 "Folder" $NqFontSmall ${NQ_TEXT3}
  !insertmacro NqLabel "un." $0 STATIC ${NQ_STATIC_PATH} 92 344 500 18 "$INSTDIR" $NqFontSmall ${NQ_TEXT2} ${NQ_BG}

  !insertmacro NqPx $1 ${NQ_LEFT}
  !insertmacro NqPx $2 388
  !insertmacro NqPx $3 15
  !insertmacro NqPx $4 24
  nsDialogs::CreateControl BUTTON 0x50010003 0 $1 $2 $3 $4 "$(deleteAppData)"
  Pop $DeleteAppDataCheckbox
  System::Call 'uxtheme::SetWindowTheme(p $DeleteAppDataCheckbox, w "DarkMode_Explorer", p 0)'
  SetCtlColors $DeleteAppDataCheckbox "" ${NQ_BG}
  !insertmacro NqText "un." $0 62 391 520 18 "Also delete my meetings, recordings and settings" $NqFontBody ${NQ_TEXT2}
  ${NSD_OnClick} $0 un.NqToggleDeleteData

  !insertmacro NqLabel "un." $0 STATIC ${NQ_STATIC_BUTTON} 400 ${NQ_ACTION_Y} 88 ${NQ_ACTION_H} "Cancel" $NqFontButton ${NQ_TEXT2} ${NQ_BG}
  ${NSD_OnClick} $0 un.NqQuit

  Call un.NqStartReveal
  nsDialogs::Show
  Call un.NqEndPage
FunctionEnd

Function un.NqConfirmLeave
  Call un.NqEndPage
  ${NSD_GetState} $DeleteAppDataCheckbox $DeleteAppDataCheckboxState
FunctionEnd

Function un.NqProgressShow
  Call un.NqPaintProgress
  StrCpy $1 ${NQ_SLATE_REF}
  Call un.NqShapeWave
  StrCpy $NqKicker "Removing ${PRODUCTNAME}"
  Call un.NqKickerDanger
FunctionEnd

Function un.NqDoneShow
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  ${If} $UpdateMode = 1
    Abort
  ${EndIf}

  StrCpy $NqPrimaryDanger 0
  Call un.NqBeginPage
  StrCpy $NqKicker "Uninstalled"
  Call un.NqKickerSuccess
  ; A spent wave: the version is gone from this PC.
  SendMessage $NqWave ${NQ_PBM_SETPOS} 0 0
  StrCpy $NqFill 100
  StrCpy $R5 "Close"
  Call un.NqPaintPrimary
  ${NSD_OnClick} $NqPrimary un.NqGoNext
  ${If} $DeleteAppDataCheckboxState = 1
    !insertmacro NqLabel "un." $0 STATIC ${NQ_STATIC} ${NQ_LEFT} ${NQ_INFO_Y} 620 44 "${PRODUCTNAME} and its data are gone from this PC." $NqFontBody ${NQ_TEXT} ${NQ_BG}
  ${Else}
    !insertmacro NqLabel "un." $0 STATIC ${NQ_STATIC} ${NQ_LEFT} ${NQ_INFO_Y} 620 44 "${PRODUCTNAME} is gone from this PC. Your meetings, recordings and settings are still here if you come back." $NqFontBody ${NQ_TEXT} ${NQ_BG}
  ${EndIf}
  ${NSD_CreateTimer} un.NqTick 16
  nsDialogs::Show
  Call un.NqEndPage
FunctionEnd

Function un.NqDoneLeave
  Call un.NqEndPage
FunctionEnd
