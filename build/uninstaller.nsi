; ---------------------------------------------------------------------------
; QuillPad 独立卸载器（QuillPad-Uninstaller-<ver>.exe）
;
; 它做什么
;   一个不依赖安装目录里那个官方卸载器的「清道夫」：
;     1. 扫描本机所有 QuillPad 的安装与残留 —— 注册表 Uninstall 子树（HKCU /
;        HKLM 两个视图）、常见安装目录、用户数据、缓存、快捷方式、关联与右键
;        菜单、MuiCache 等；
;     2. 把清单写进日志并让用户确认；
;     3. 需要管理员才删得动时自动提权（UAC），per-user 安装则不打扰；
;     4. 逐项删除，删不掉（占用 / 权限）的登记重启后清理，最后报结果。
;
; 为什么不再「转交官方卸载器」
;   旧版只读注册表找到 Uninstall QuillPad.exe 然后 Exec 它。问题是：
;     · 官方卸载器一旦被手动删掉 / 安装目录残缺，就什么都清不了；
;     · 历史版本（1.1.x）换过安装位置，注册表只剩一个键，前面版本的目录、
;       缓存、任务栏图标全留在原地；
;     · 官方卸载器自己也不清 CrashDumps / MuiCache / 其他版本的目录。
;   所以这里改成自己扫、自己删，痕迹清单一律来自 build/traces.nsh —— 和安装
;   器共用同一份定义，装了什么就清什么。
;
; 命令行
;   /S           静默（不弹任何对话框）
;   /SCAN        只扫描不删除。退出码：0 = 干净，1 = 有痕迹，2 = 出错
;   /ELEVATED    内部用：已提权的标记，防止反复提权
;   /NOELEVATE   内部用：禁止自动提权（以当前权限尽力清理）
;   日志：%TEMP%\QuillPad-Uninstall.log（UTF-16LE，带 BOM）
;
; 编译：node build/build-uninstaller.mjs（自动查找 makensis），不要手工调用。
; ---------------------------------------------------------------------------

Unicode true
SetCompressor /SOLID lzma

!include "MUI2.nsh"

; 独立编译：让 traces.nsh 声明它需要的那批变量
!define QP_STANDALONE
!include "traces.nsh"

; ---- 构建期由 /D 传入；缺省值保证脚本能被单独编译 ----
!ifndef APP_VERSION
  !define APP_VERSION "1.0.0"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "QuillPad-Uninstaller.exe"
!endif
!ifndef ICON_FILE
  !define ICON_FILE ""
!endif

Name "卸载 QuillPad ${APP_VERSION}"
OutFile "${OUT_FILE}"
RequestExecutionLevel user
ShowInstDetails show
BrandingText "QuillPad ${APP_VERSION}"

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "QuillPad 卸载程序"
VIAddVersionKey /LANG=2052 "FileDescription" "卸载 QuillPad 文本编辑器并清理全部痕迹"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "QuillPad"

!if "${ICON_FILE}" != ""
  Icon "${ICON_FILE}"
  WindowIcon on
!endif

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Var QpScanOnly        ; 1 = 只扫描
Var QpAdmin           ; 1 = 当前进程已提权
Var QpElevated        ; 1 = 本次是提权后的重启（或明确禁止再提权）
Var QpNeedsElev       ; 1 = 有必须管理员才能删的目标
Var QpPassArgs        ; 提权重启时要带上的参数
Var QpFound           ; 扫描命中的痕迹总数
Var QpLogPath         ; 日志文件路径

; 是否存在「非管理员删不掉」的目标：Program Files 下的安装目录 / HKLM 卸载项
Function QpNeedsElevation
  StrCpy $QpNeedsElev 0

  ${If} ${FileExists} "$PROGRAMFILES64\QuillPad\*.*"
    StrCpy $QpNeedsElev 1
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES\QuillPad\*.*"
    StrCpy $QpNeedsElev 1
  ${EndIf}

  ${If} $QpNeedsElev == 0
    ${If} ${RunningX64}
      SetRegView 64
    ${EndIf}
    ; 逐个看 HKLM 的卸载项，找 DisplayName 带 QuillPad 的（键名是 GUID，没法直查）
    StrCpy $QpIdx 0
    ${Do}
      EnumRegKey $QpName HKLM "${QP_UNINST_ROOT}" $QpIdx
      ${If} $QpName == ""
        ${Break}
      ${EndIf}
      IntOp $QpIdx $QpIdx + 1
      ReadRegStr $QpA HKLM "${QP_UNINST_ROOT}\$QpName" "DisplayName"
      ${If} $QpA != ""
        !insertmacro QP_STRSTR "$QpA" "quillpad" "$QpPos"
        ${If} $QpPos != ""
          StrCpy $QpNeedsElev 1
          ${Break}
        ${EndIf}
      ${EndIf}
      ${If} $QpIdx > 500
        ${Break}
      ${EndIf}
    ${Loop}
    ${If} ${RunningX64}
      SetRegView lastused
    ${EndIf}
  ${EndIf}
FunctionEnd

; 需要时提权重启自己。用户拒绝 UAC 就继续用当前权限尽力清。
Function QpMaybeElevate
  ${If} $QpAdmin == 1
    Return
  ${EndIf}
  ${If} $QpElevated == 1
    Return
  ${EndIf}

  Call QpNeedsElevation
  ${If} $QpNeedsElev == 0
    Return
  ${EndIf}

  ${If} ${Silent}
    !insertmacro QP_LOGLINE "  ! 当前不是管理员：Program Files / 全用户组件可能清不干净"
    !insertmacro QP_LOGLINE "  ! 需要彻底清理请以管理员身份运行"
    Return
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "检测到 QuillPad 安装在 Program Files（或存在全用户范围的组件），$\r$\n清理它们需要管理员权限。$\r$\n$\r$\n现在提权继续吗？（会弹出 UAC 确认框）" \
    IDYES elevate IDNO skip

  elevate:
    ClearErrors
    ExecShell "runas" "$EXEPATH" "$QpPassArgs /ELEVATED"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "提权被取消，将以当前权限继续。Program Files 下的文件可能删不掉。"
      Return
    ${EndIf}
    Quit

  skip:
    !insertmacro QP_LOGLINE "  ! 用户选择不提权，仅清理当前用户范围"
FunctionEnd

; ------------------------------------------------------------------ 入口
Function .onInit
  StrCpy $QpMode "scan"
  StrCpy $QpScanOnly 0
  StrCpy $QpElevated 0
  StrCpy $QpNeedsElev 0
  StrCpy $QpPassArgs ""
  StrCpy $QpFound 0
  SetShellVarContext current

  ; ---- 命令行开关（StrCmp 系比较本身不区分大小写，不用额外转小写）----
  ${GetParameters} $QpA
  !insertmacro QP_STRSTR "$QpA" "/scan" "$QpPos"
  ${If} $QpPos != ""
    StrCpy $QpScanOnly 1
    StrCpy $QpPassArgs "/SCAN"
  ${EndIf}
  !insertmacro QP_STRSTR "$QpA" "/elevated" "$QpPos"
  ${If} $QpPos != ""
    StrCpy $QpElevated 1
  ${EndIf}
  !insertmacro QP_STRSTR "$QpA" "/noelevate" "$QpPos"
  ${If} $QpPos != ""
    StrCpy $QpElevated 1     ; 复用：等同于「别再提权了」
  ${EndIf}

  ; ---- 权限 ----
  UserInfo::GetAccountType
  Pop $QpA
  ${If} $QpA == "Admin"
    StrCpy $QpAdmin 1
  ${Else}
    StrCpy $QpAdmin 0
  ${EndIf}

  ; ---- 日志（UTF-16LE + BOM，路径带中文也不会乱码）----
  StrCpy $QpLogPath "$TEMP\QuillPad-Uninstall.log"
  FileOpen $QpLogHandle "$QpLogPath" w
  FileWriteUTF16LE /BOM $QpLogHandle "==== QuillPad 卸载器 ${APP_VERSION} ====$\r$\n"
  ${If} $QpAdmin == 1
    !insertmacro QP_LOGLINE "权限：管理员"
  ${Else}
    !insertmacro QP_LOGLINE "权限：普通用户"
  ${EndIf}

  ; ---- 扫描（只统计，不动任何东西）----
  StrCpy $QpMode "scan"
  !insertmacro QP_RESET_COUNTERS
  !insertmacro QP_SWEEP_ALL
  StrCpy $QpFound $QpHitDirs
  IntOp $QpFound $QpFound + $QpHitFiles
  IntOp $QpFound $QpFound + $QpHitKeys
  IntOp $QpFound $QpFound + $QpHitVals
  !insertmacro QP_LOGLINE "---- 扫描命中：目录 $QpHitDirs · 文件 $QpHitFiles · 注册表键 $QpHitKeys · 注册表值 $QpHitVals ----"

  ; ---- 只扫描：报告 + 退出码 ----
  ${If} $QpScanOnly == 1
    !insertmacro QP_LOGLINE "==== 扫描结束（未做任何删除）===="
    FileClose $QpLogHandle
    StrCpy $QpLogHandle ""
    ${If} $QpFound == 0
      SetErrorLevel 0
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONINFORMATION "本机没有发现 QuillPad 的安装痕迹。"
      ${EndIf}
    ${Else}
      SetErrorLevel 1
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONINFORMATION \
          "发现 QuillPad 的安装或残留痕迹：$\r$\n$\r$\n目录 $QpHitDirs 处 · 文件 $QpHitFiles 个$\r$\n注册表键 $QpHitKeys 项 · 注册表值 $QpHitVals 项$\r$\n$\r$\n详细清单：$QpLogPath"
      ${EndIf}
    ${EndIf}
    Quit
  ${EndIf}

  ; ---- 什么都没找到 ----
  ${If} $QpFound == 0
    !insertmacro QP_LOGLINE "==== 无痕迹，无需清理 ===="
    FileClose $QpLogHandle
    StrCpy $QpLogHandle ""
    SetErrorLevel 0
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION \
        "本机没有发现 QuillPad 的安装痕迹。$\r$\n$\r$\n如果你用的是便携版，直接删除那个 exe 和同目录的 QuillPad-Data 文件夹即可。"
    ${EndIf}
    Quit
  ${EndIf}

  ; ---- 提权（提权后的进程会带着 /ELEVATED 重新进来，重扫一遍）----
  Call QpMaybeElevate
  ${If} $QpElevated == 1
    StrCpy $QpMode "scan"
    !insertmacro QP_RESET_COUNTERS
    !insertmacro QP_SWEEP_ALL
    StrCpy $QpFound $QpHitDirs
    IntOp $QpFound $QpFound + $QpHitFiles
    IntOp $QpFound $QpFound + $QpHitKeys
    IntOp $QpFound $QpFound + $QpHitVals
  ${EndIf}

  ; ---- 确认 ----
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION \
      "将删除 QuillPad 并清理全部痕迹：$\r$\n$\r$\n· 程序目录（含历史版本遗留的安装位置）$\r$\n· 设置、会话、最近文件、插件与缓存$\r$\n· 文件关联、右键菜单、开始菜单与桌面快捷方式$\r$\n· 注册表中的卸载项与残留值$\r$\n$\r$\n共发现 目录 $QpHitDirs 处 / 文件 $QpHitFiles 个 / 注册表 $QpHitKeys 键 $QpHitVals 值。$\r$\n正在运行的 QuillPad 会被强制关闭（未保存的内容会丢失）。$\r$\n$\r$\n此操作不可撤销，继续吗？" \
      IDYES confirmed IDNO cancelled
    cancelled:
      FileClose $QpLogHandle
      SetErrorLevel 3
      Quit
    confirmed:
  ${EndIf}
FunctionEnd

; ------------------------------------------------------------------ 清扫
Section "-Purge"
  StrCpy $QpMode "delete"

  ; 1) 先关掉本体：文件被占用时 RMDir 会失败并退化成「重启后清理」
  DetailPrint "关闭正在运行的 QuillPad…"
  nsExec::ExecToStack 'taskkill /F /IM ${QP_APP_EXE} /T'
  Pop $QpA
  Pop $QpB

  ; 2) 注册表里捞到的自定义安装目录（用户装到 D:\Apps\QuillPad 这类位置）
  ;    $QpInstallDirs 形如 "|D:\Apps\QuillPad|E:\Tools\QuillPad"（首项为空），
  ;    所以判空要看列表本身而不是切出来的那一段 —— 否则第一次就 Break。
  StrCpy $QpList "$QpInstallDirs"
  ${Do}
    ${If} $QpList == ""
      ${Break}
    ${EndIf}
    !insertmacro QP_LIST_POP
    ${If} $QpA != ""
      !insertmacro QP_DIR "$QpA"
    ${EndIf}
  ${Loop}
  StrCpy $QpInstallDirs ""

  ; 3) 全量清扫（安装目录 / 用户数据 / 缓存 / 快捷方式 / 注册表 / 关联）
  !insertmacro QP_SWEEP_ALL

  ; 4) 全用户范围（Program Files 安装时快捷方式落在 Public 下）
  ${If} $QpAdmin == 1
    SetShellVarContext all
    !insertmacro QP_SWEEP_SHORTCUTS
    !insertmacro QP_SWEEP_EMPTY_DIRS
    SetShellVarContext current
  ${EndIf}

  ; 5) 资源管理器缓存刷新，别让「打开方式」列表里还挂着已经删掉的名字
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
SectionEnd

; ------------------------------------------------------------------ 收尾
Function .onInstSuccess
  !insertmacro QP_LOGLINE "---- 清理完成：目录 $QpHitDirs · 文件 $QpHitFiles · 注册表键 $QpHitKeys · 注册表值 $QpHitVals · 失败 $QpFail ----"
  ${If} $QpFail == 0
    !insertmacro QP_LOGLINE "结果：干净（0 项失败）"
    SetErrorLevel 0
  ${Else}
    !insertmacro QP_LOGLINE "结果：有 $QpFail 项未能立即删除，已登记重启后清理"
    SetErrorLevel 2
  ${EndIf}
  FileClose $QpLogHandle
  StrCpy $QpLogHandle ""

  ${IfNot} ${Silent}
    ${If} $QpFail == 0
      MessageBox MB_OK|MB_ICONINFORMATION \
        "QuillPad 已卸载，痕迹已清理干净。$\r$\n$\r$\n详细报告：$QpLogPath"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "QuillPad 已卸载，但有 $QpFail 项被占用或权限不足，未能立即删除，$\r$\n已登记在下次重启时清理。$\r$\n$\r$\n详细报告：$QpLogPath"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function .onInstFailed
  FileClose $QpLogHandle
  SetErrorLevel 2
FunctionEnd
