; ---------------------------------------------------------------------------
; QuillPad · NSIS 安装器扩展
;
; 负责四件 electron-builder 默认不做的事：
;   1. 在「所有文件」的右键菜单里加一项「用 QuillPad 打开」；
;   2. 注册 ProgID + 全部支持扩展名的 OpenWithProgids，
;      让 QuillPad 出现在「打开方式」列表里；
;   3. 新增「文件关联」选择页：用户勾选的类型**真正设为默认**（写
;      HKCU\Software\Classes\.ext 的默认值，并撤掉系统的 UserChoice 保护），
;      同时注册 Capabilities，让「设置 → 应用 → 默认应用」里也能看到并改回来；
;   4. 卸载时把这些注册表项、快捷方式与用户数据一并清干净。
;
; 全部写 HKCU：本安装器是 per-user 安装，不需要管理员权限，
; 卸载时也不需要提权就能删干净。
;
; 注意：卸载清理的「痕迹清单」不在本文件里维护，统一来自 build/traces.nsh ——
; 与独立卸载器 QuillPad-Uninstaller-<ver>.exe 共用同一份定义，避免装了什么、
; 删了什么两边对不上。
;
; 编译顺序注意（踩过）：electron-builder 会把本文件 !include 在模板**之前**
; （`scriptGenerator.build() + originalScript`），所以这里不能直接用 MUI 宏 ——
; 那时 MUI2.nsh 还没被包含。页面相关的代码一律写进 `customPageAfterChangeDir`
; 宏里：该宏在 assistedInstaller.nsh 第 43 行展开，MUI2 已就绪。
; ---------------------------------------------------------------------------

!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "traces.nsh"

; 关联选择的四组开关（勾 = 设为默认打开方式）。
; 声明放在 !ifndef 里：编译卸载器那一趟（BUILD_UNINSTALLER）用不到它们，
; 而 electron-builder 带 -WX 编译，任何「未使用变量」警告都会直接变成错误。
!ifndef BUILD_UNINSTALLER
  Var QpAssocMd         ; Markdown（.md .markdown）
  Var QpAssocPlain      ; 纯文本与日志（.txt .log）
  Var QpAssocCode       ; 代码
  Var QpAssocCfg        ; 配置与数据
  Var QpAssocCtlMd
  Var QpAssocCtlPlain
  Var QpAssocCtlCode
  Var QpAssocCtlCfg
  Var QpAssocPrev       ; 读旧 UserChoice 用
!endif

; ------------------------------------------------------- 关联注册（安装）
; 单条扩展名：写入 OpenWithProgids（候选程序），不动默认关联。
; 清单见 traces.nsh 的 QP_EXTS_* 分组。
!macro QP_ASSOC_EXT EXT
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "${QP_PROGID}" ""
  WriteRegStr HKCU "Software\Classes\Applications\${QP_APP_EXE}\SupportedTypes" "${EXT}" ""
!macroend

; 单条扩展名：能力清单（设置页展示用，与是否设为默认无关）
!macro QP_ASSOC_CAPABILITY EXT
  WriteRegStr HKCU "Software\QuillPad\Capabilities\FileAssociations" "${EXT}" "${QP_PROGID}"
!macroend

; 单条扩展名：**设为默认打开方式**
;
; 两件事缺一不可 ——
;   a) HKCU\Software\Classes\.ext 的默认值 = 我们的 ProgID：没有用户选择记录时，
;      Windows 就按这个解析；
;   b) 删掉 Explorer\FileExts\.ext\UserChoice：Win8 之后只要存在 UserChoice，
;      (a) 会被完全忽略。该键带哈希校验，程序不能改写，只能整键删除 —— 删掉后
;      系统回落到 (a)。用户既然在上一页勾了这一组，就是明确同意接管；卸载器会
;      把指向我们的 UserChoice 一并撤掉（见 traces.nsh 的 QP_DROP_EXT）。
!macro QP_ASSOC_DEFAULT EXT
  WriteRegStr HKCU "Software\Classes\${EXT}" "" "${QP_PROGID}"
  ReadRegStr $QpAssocPrev HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\UserChoice" "ProgId"
  ${If} $QpAssocPrev != ""
  ${AndIf} $QpAssocPrev != "${QP_PROGID}"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\UserChoice"
  ${EndIf}
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

  ; ---- 能力注册：Windows「设置 → 应用 → 默认应用」里的一条 QuillPad ----
  ; 没有它，用户只能靠「打开方式 → 选择其他应用」；有了它就能成组地改回来。
  WriteRegStr HKCU "Software\QuillPad\Capabilities" "ApplicationName" "QuillPad"
  WriteRegStr HKCU "Software\QuillPad\Capabilities" "ApplicationDescription" "QuillPad 文本与 Markdown 编辑器"
  WriteRegStr HKCU "Software\QuillPad\Capabilities" "ApplicationIcon" "$INSTDIR\${QP_APP_EXE},0"
  !insertmacro QP_EACH_EXT QP_ASSOC_CAPABILITY
  WriteRegStr HKCU "Software\RegisteredApplications" "QuillPad" "Software\QuillPad\Capabilities"
!macroend

; ------------------------------------------------------- 关联注销（卸载）
; 清单与动作都在 traces.nsh 里（QP_SWEEP_ASSOC / QP_SWEEP_REG_MAIN），
; 这里不重复定义，免得两边漂移 —— 独立卸载器用的是同一套。

; ------------------------------------------------------------- 文件关联页
; 展开点在 assistedInstaller.nsh（目录页之后、安装进度页之前），因此这里可以用
; MUI_HEADER_TEXT。静默安装（/S）不会走到页面函数，取值来自 customInit 的默认值。
!macro customPageAfterChangeDir
  Function QpAssocPageCreate
    !insertmacro MUI_HEADER_TEXT "文件关联" "选择哪些文件类型默认用 QuillPad 打开"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 26u "勾选的类型将默认用 QuillPad 打开，双击文件即进入 QuillPad。$\r$\n取消勾选只是把它们放进「打开方式」列表，不会改动系统当前的默认程序。"
    Pop $0

    ${NSD_CreateCheckbox} 0 30u 100% 12u "Markdown 文档（.md、.markdown）"
    Pop $QpAssocCtlMd
    ${NSD_CreateCheckbox} 0 42u 100% 12u "纯文本与日志（.txt、.log）"
    Pop $QpAssocCtlPlain
    ${NSD_CreateCheckbox} 0 54u 100% 12u "代码文件（.js、.ts、.py、.css、.html 等 31 种）"
    Pop $QpAssocCtlCode
    ${NSD_CreateCheckbox} 0 66u 100% 12u "配置与数据（.json、.yml、.ini、.csv 等 15 种）"
    Pop $QpAssocCtlCfg

    ${If} $QpAssocMd == 1
      ${NSD_Check} $QpAssocCtlMd
    ${EndIf}
    ${If} $QpAssocPlain == 1
      ${NSD_Check} $QpAssocCtlPlain
    ${EndIf}
    ${If} $QpAssocCode == 1
      ${NSD_Check} $QpAssocCtlCode
    ${EndIf}
    ${If} $QpAssocCfg == 1
      ${NSD_Check} $QpAssocCtlCfg
    ${EndIf}

    ${NSD_CreateLabel} 0 82u 100% 40u "Windows 会保护你手动指定过的默认程序，安装时会按上面的勾选重新指向 QuillPad。装完仍可在「设置 → 应用 → 默认应用 → QuillPad」里逐项改回，或重新运行安装程序重新勾选。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function QpAssocPageLeave
    ${NSD_GetState} $QpAssocCtlMd $QpAssocMd
    ${NSD_GetState} $QpAssocCtlPlain $QpAssocPlain
    ${NSD_GetState} $QpAssocCtlCode $QpAssocCode
    ${NSD_GetState} $QpAssocCtlCfg $QpAssocCfg
  FunctionEnd

  Page custom QpAssocPageCreate QpAssocPageLeave
!macroend

; 默认值必须在 .onInit 里就给好：静默安装不经过页面函数，
; 而 customInstall 读的就是这几个变量。
!macro customInit
  StrCpy $QpAssocMd 1
  StrCpy $QpAssocPlain 1
  StrCpy $QpAssocCode 1
  StrCpy $QpAssocCfg 1

  ; 企业部署 / 自动化测试：/NOASSOC 完全不改默认关联
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/NOASSOC" $R1
  ${IfNot} ${Errors}
    StrCpy $QpAssocMd 0
    StrCpy $QpAssocPlain 0
    StrCpy $QpAssocCode 0
    StrCpy $QpAssocCfg 0
  ${EndIf}
!macroend

; ------------------------------------------------------------------- 安装
!macro customInstall
  SetShellVarContext current

  ; 所有文件右键 → 用 QuillPad 打开（资源管理器顶层菜单项）
  WriteRegStr HKCU "Software\Classes\*\shell\QuillPad" "" "用 QuillPad 打开(&Q)"
  WriteRegStr HKCU "Software\Classes\*\shell\QuillPad" "Icon" "$INSTDIR\${QP_APP_EXE},0"
  WriteRegStr HKCU "Software\Classes\*\shell\QuillPad" "MultiSelectModel" "Single"
  WriteRegStr HKCU "Software\Classes\*\shell\QuillPad\command" "" '"$INSTDIR\${QP_APP_EXE}" "%1"'

  !insertmacro QP_REGISTER_ASSOCIATIONS

  ; ---- 按勾选把分组设为默认打开方式 ----
  ${If} $QpAssocMd == 1
    !insertmacro QP_EXTS_MARKDOWN QP_ASSOC_DEFAULT
  ${EndIf}
  ${If} $QpAssocPlain == 1
    !insertmacro QP_EXTS_PLAIN QP_ASSOC_DEFAULT
  ${EndIf}
  ${If} $QpAssocCode == 1
    !insertmacro QP_EXTS_CODE QP_ASSOC_DEFAULT
  ${EndIf}
  ${If} $QpAssocCfg == 1
    !insertmacro QP_EXTS_CONFIG QP_ASSOC_DEFAULT
  ${EndIf}

  ; 让 Win+R 能直接启动
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${QP_APP_EXE}" "" "$INSTDIR\${QP_APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${QP_APP_EXE}" "Path" "$INSTDIR"

  ; 开始菜单里放一个显眼的卸载入口（卸载文件本体在安装目录）
  Delete "$SMPROGRAMS\卸载 QuillPad.lnk"
  CreateShortCut "$SMPROGRAMS\卸载 QuillPad.lnk" "$INSTDIR\${QP_UNINST_EXE}" "" "$INSTDIR\${QP_UNINST_EXE}" 0

  ; 通知资源管理器刷新关联缓存：右键菜单与默认程序都不用重启才生效
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
