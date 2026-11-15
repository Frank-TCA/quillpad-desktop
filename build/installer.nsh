; ---------------------------------------------------------------------------
; QuillPad · NSIS 安装器扩展
;
; 负责三件 electron-builder 默认不做的事：
;   1. 在「所有文件」的右键菜单里加一项「用 QuillPad 打开」；
;   2. 注册 ProgID + 常见文本扩展名的 OpenWithProgids，
;      让 QuillPad 出现在「打开方式」列表里，但不抢占系统默认程序；
;   3. 卸载时把这些注册表项、快捷方式与用户数据一并清干净。
;
; 全部写 HKCU：本安装器是 per-user 安装，不需要管理员权限，
; 卸载时也不需要提权就能删干净。
;
; 注意：卸载清理的「痕迹清单」不在本文件里维护，统一来自 build/traces.nsh ——
; 与独立卸载器 QuillPad-Uninstaller-<ver>.exe 共用同一份定义，避免装了什么、
; 删了什么两边对不上。
; ---------------------------------------------------------------------------

!include "LogicLib.nsh"
!include "traces.nsh"

; ------------------------------------------------------- 关联注册（安装）
; 单条扩展名：只写入 OpenWithProgids（候选程序），不覆盖已有默认关联，
; 用户想设为默认仍需自己在系统设置里确认。清单见 traces.nsh 的 QP_EACH_EXT。
!macro QP_ASSOC_EXT EXT
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "${QP_PROGID}" ""
  WriteRegStr HKCU "Software\Classes\Applications\${QP_APP_EXE}\SupportedTypes" "${EXT}" ""
!macroend

!macro QP_REGISTER_ASSOCIATIONS
  ; ---- ProgID：文件类型本体 ----
  WriteRegStr HKCU "Software\Classes\${QP_PROGID}" "" "QuillPad 文本文件"
  WriteRegStr HKCU "Software\Classes\${QP_PROGID}" "FriendlyTypeName" "QuillPad 文本文件"
  WriteRegStr HKCU "Software\Classes\${QP_PROGID}" "AlwaysShowExt" ""
  WriteRegStr HKCU "Software\Classes\${QP_PROGID}\DefaultIcon" "" "$INSTDIR\${QP_APP_EXE},0"
  WriteRegStr HKCU "Software\Classes\${QP_PROGID}\shell\open" "" "用 QuillPad 打开(&Q)"
  WriteRegStr HKCU "Software\Classes\${QP_PROGID}\shell\open\command" "" '"$INSTDIR\${QP_APP_EXE}" "%1"'
  WriteRegStr HKCU "Software\Classes\${QP_PROGID}\shell\edit" "" "编辑(&E)"
  WriteRegStr HKCU "Software\Classes\${QP_PROGID}\shell\edit\command" "" '"$INSTDIR\${QP_APP_EXE}" "%1"'

  ; ---- 应用身份：让「打开方式」列表显示友好名称与图标 ----
  WriteRegStr HKCU "Software\Classes\Applications\${QP_APP_EXE}" "FriendlyAppName" "QuillPad"
  WriteRegStr HKCU "Software\Classes\Applications\${QP_APP_EXE}" "ApplicationCompany" "QuillPad"
  WriteRegStr HKCU "Software\Classes\Applications\${QP_APP_EXE}\DefaultIcon" "" "$INSTDIR\${QP_APP_EXE},0"
  WriteRegStr HKCU "Software\Classes\Applications\${QP_APP_EXE}\shell\open" "" "用 QuillPad 打开(&Q)"
  WriteRegStr HKCU "Software\Classes\Applications\${QP_APP_EXE}\shell\open\command" "" '"$INSTDIR\${QP_APP_EXE}" "%1"'

  !insertmacro QP_EACH_EXT QP_ASSOC_EXT
!macroend

; ------------------------------------------------------- 关联注销（卸载）
; 清单与动作都在 traces.nsh 里（QP_SWEEP_ASSOC / QP_SWEEP_REG_MAIN），
; 这里不重复定义，免得两边漂移 —— 独立卸载器用的是同一套。

; ------------------------------------------------------------------- 安装
!macro customInstall
  SetShellVarContext current

  ; 所有文件右键 → 用 QuillPad 打开（资源管理器顶层菜单项）
  WriteRegStr HKCU "Software\Classes\*\shell\QuillPad" "" "用 QuillPad 打开(&Q)"
  WriteRegStr HKCU "Software\Classes\*\shell\QuillPad" "Icon" "$INSTDIR\${QP_APP_EXE},0"
  WriteRegStr HKCU "Software\Classes\*\shell\QuillPad" "MultiSelectModel" "Single"
  WriteRegStr HKCU "Software\Classes\*\shell\QuillPad\command" "" '"$INSTDIR\${QP_APP_EXE}" "%1"'

  !insertmacro QP_REGISTER_ASSOCIATIONS

  ; 让 Win+R 能直接启动
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${QP_APP_EXE}" "" "$INSTDIR\${QP_APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${QP_APP_EXE}" "Path" "$INSTDIR"

  ; 开始菜单里放一个显眼的卸载入口（卸载文件本体在安装目录）
  Delete "$SMPROGRAMS\卸载 QuillPad.lnk"
  CreateShortCut "$SMPROGRAMS\卸载 QuillPad.lnk" "$INSTDIR\${QP_UNINST_EXE}" "" "$INSTDIR\${QP_UNINST_EXE}" 0

  ; 通知资源管理器刷新关联缓存，避免要重启才看到右键菜单
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

; ------------------------------------------------------------------- 卸载
; 官方卸载器（开始菜单 / 控制面板点进来）也走完整的痕迹清单：不只是删 $INSTDIR，
; 还要把历史版本换个位置装的目录、旧缓存、关联与注册表残留一起收掉。
!macro customUnInstall
  SetShellVarContext current
  StrCpy $QpMode "delete"
  !insertmacro QP_RESET_COUNTERS

  Delete "$SMPROGRAMS\卸载 QuillPad.lnk"

  ; ---- 关联 / 应用身份 / 右键菜单 / App Paths / 开机自启 / MuiCache ----
  !insertmacro QP_SWEEP_REG_MAIN
  !insertmacro QP_SWEEP_ASSOC

  ; ---- 用户数据 / 缓存 / 崩溃转储 / 快捷方式 ----
  !insertmacro QP_SWEEP_DATA_DIRS
  !insertmacro QP_SWEEP_STRAY_FILES
  !insertmacro QP_SWEEP_SHORTCUTS
  !insertmacro QP_SWEEP_EMPTY_DIRS

  ; ---- 历史版本：注册表里登记过的所有 QuillPad 卸载项与安装位置 ----
  !insertmacro QP_SWEEP_UNINST_ALL
  StrCpy $QpList "$QpInstallDirs"
  ${Do}
    ${If} $QpList == ""
      ${Break}
    ${EndIf}
    !insertmacro QP_LIST_POP
    ${If} $QpA != ""
      ${If} $QpA != "$INSTDIR"
        ; $INSTDIR 交给 electron-builder 自己删，别和它的收尾抢
        !insertmacro QP_DIR "$QpA"
      ${EndIf}
    ${EndIf}
  ${Loop}

  ; ---- 其他版本的安装目录（换过安装位置的那批）----
  !insertmacro QP_SWEEP_INSTALL_DIRS

  RMDir "$SMPROGRAMS\QuillPad"

  ; 通知资源管理器：关联已变更
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
