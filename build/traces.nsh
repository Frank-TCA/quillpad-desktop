; ---------------------------------------------------------------------------
; QuillPad · 卸载痕迹清单与清理原语
;
; 谁在用它
;   build/installer.nsh     装进系统的官方卸载器（customUnInstall）
;   build/uninstaller.nsi   独立卸载器 QuillPad-Uninstaller-<ver>.exe
;
; 为什么单独抽出来
;   安装端「写了什么」和卸载端「删了什么」必须一一对应。放在两个文件里迟早
;   漂移 —— 1.1.x 时期就漏了 CrashDumps、MuiCache、任务栏固定项和历史版本的
;   安装目录（换过安装位置的那批）。这里只描述「痕迹在哪」，动作由调用方决定。
;
; 硬约束：本文件里不许出现 Call
;   electron-builder 生成的卸载段只允许 Call `un.*` 函数，而共享代码会被编进
;   那个卸载段。用 StrFunc 的 ${StrCase}/${StrLoc}（内部就是 Call）会直接编译
;   失败（"Call must be used with function names starting with un."）。所以：
;     · 字符串比较一律用 LogicLib 的 ${If} $a == "b" —— 底层 StrCmp 本身就不
;       区分大小写，够用；
;     · 子串查找自己用逐字符循环实现（QP_STRSTR）；
;     · 日志直接 DetailPrint + FileWriteUTF16LE，不做函数转发。
;
; 两种模式（$QpMode）
;   "scan"    只统计 + 记日志，不动任何东西。用于卸载前的预览，以及自动化
;             测试里做「能不能发现历史痕迹」的断言。
;   "delete"  真删，删不掉（占用 / 权限）的登记 REBOOTOK 并计入失败数。
; ---------------------------------------------------------------------------

!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

; ------------------------------------------------------------------ 常量
!define QP_UNINST_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"
!define QP_PROGID "QuillPad.TextFile"
!define QP_APP_EXE "QuillPad.exe"
!define QP_UNINST_EXE "Uninstall QuillPad.exe"
!define QP_APP_KEY "Software\QuillPad"

; ------------------------------------------------------------------ 状态
; 只在「真的会用到这些变量」的编译阶段声明。
;   QP_STANDALONE      独立卸载器自己定义了（见 uninstaller.nsi 顶部）
;   BUILD_UNINSTALLER  electron-builder 生成卸载器的那一趟
; 安装器那一趟这两者都没有：此时本文件里的宏一个都不会展开，声明了只会换来
; 「Variable not referenced」警告，而 electron-builder 把警告当错误（编译失败）。
!ifdef QP_STANDALONE
  !define QP_DECLARE_VARS
!endif
!ifdef BUILD_UNINSTALLER
  !define QP_DECLARE_VARS
!endif

!ifdef QP_DECLARE_VARS
  Var QpMode            ; "scan" | "delete"
  Var QpHitDirs         ; 命中目录数
  Var QpHitFiles        ; 命中文件数
  Var QpHitKeys         ; 命中注册表键数
  Var QpHitVals         ; 命中注册表值数
  Var QpFail            ; 删除失败数
  Var QpInstallDirs     ; 从注册表捞到的安装目录，以 "|" 分隔
  Var QpLogHandle       ; 日志文件句柄（仅独立卸载器使用）

  ; 临时变量（统一 Qp 前缀，避免和 NSIS 的 $R0-$R9 抢）
  Var QpA
  Var QpB
  Var QpC
  Var QpD
  Var QpHay             ; QP_STRSTR 的干草堆副本（不破坏调用方变量）
  Var QpNLen            ; QP_STRSTR 的针长
  Var QpS               ; QP_STRSTR 的游标
  Var QpPos             ; QP_STRSTR 的结果："" = 未找到，否则是 0 起的偏移
  Var QpIdx
  Var QpList            ; 用于 QP_LIST_POP 的待切分列表
  Var QpName
  Var QpData
  Var QpCount
!endif

; ------------------------------------------------------------------ 原语
; 记一行日志：详情面板 + 日志文件（没打开日志文件时只打详情面板）。
!macro QP_LOGLINE TEXT
  DetailPrint "${TEXT}"
  ${If} $QpLogHandle != ""
    FileWriteUTF16LE $QpLogHandle "${TEXT}$\r$\n"
  ${EndIf}
!macroend

; 不区分大小写地在 HAY 里找 NEEDLE，结果写进 POS（"" = 没找到）。
; 只用指令与 LogicLib，不产生 Call —— 见文件头「硬约束」。
!macro QP_STRSTR HAY NEEDLE POS
  StrCpy ${POS} ""
  StrCpy $QpHay "${HAY}"
  StrLen $QpNLen "${NEEDLE}"
  ${If} $QpNLen > 0
    StrCpy $QpS 0
    ${Do}
      StrCpy $QpB $QpHay 1 $QpS
      ${If} $QpB == ""
        ${Break}
      ${EndIf}
      StrCpy $QpC $QpHay "$QpNLen" "$QpS"
      ${If} $QpC == "${NEEDLE}"
        StrCpy ${POS} "$QpS"
        ${Break}
      ${EndIf}
      IntOp $QpS $QpS + 1
      ${If} $QpS > 400
        ${Break}
      ${EndIf}
    ${Loop}
  ${EndIf}
!macroend

; 从 $QpList 里取出首个 "|" 之前的片段写进 $QpA，$QpList 同步缩短。
; 「注册表里捞到的安装目录」就是这样一个个取出来删的。
!macro QP_LIST_POP
  StrCpy $QpA ""
  !insertmacro QP_STRSTR "$QpList" "|" "$QpPos"
  ${If} $QpPos == ""
    StrCpy $QpA "$QpList"
    StrCpy $QpList ""
  ${Else}
    StrCpy $QpA "$QpList" "$QpPos"
    IntOp $QpD $QpPos + 1
    StrCpy $QpList "$QpList" "" "$QpD"
  ${EndIf}
!macroend

; 目录：统计 + 删除
!macro QP_DIR PATH
  ${If} ${FileExists} "${PATH}\*.*"
    IntOp $QpHitDirs $QpHitDirs + 1
    !insertmacro QP_LOGLINE "    目录    ${PATH}"
  ${EndIf}
  ${If} $QpMode == "delete"
    RMDir /r "${PATH}"
    ${If} ${FileExists} "${PATH}\*.*"
      RMDir /r /REBOOTOK "${PATH}"
      IntOp $QpFail $QpFail + 1
      !insertmacro QP_LOGLINE "    ! 未能立即删除（占用或权限不足），已登记重启后清理：${PATH}"
    ${EndIf}
  ${EndIf}
!macroend

; 文件（支持通配符）：统计 + 删除
!macro QP_FILE PATH
  ${If} ${FileExists} "${PATH}"
    IntOp $QpHitFiles $QpHitFiles + 1
    !insertmacro QP_LOGLINE "    文件    ${PATH}"
    ${If} $QpMode == "delete"
      Delete "${PATH}"
      ${If} ${FileExists} "${PATH}"
        Delete /REBOOTOK "${PATH}"
        IntOp $QpFail $QpFail + 1
        !insertmacro QP_LOGLINE "    ! 未能立即删除（占用或权限不足），已登记重启后清理：${PATH}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; 注册表键（连子键一起删）。存在性探测：默认值 / 首个子键 / 首个值，任一非空
; 即认为键存在 —— 本产品的键都带值，误判概率可忽略。
!macro QP_REGKEY ROOT KEY
  StrCpy $QpData ""
  ReadRegStr $QpData ${ROOT} "${KEY}" ""
  ${If} $QpData == ""
    EnumRegKey $QpData ${ROOT} "${KEY}" 0
  ${EndIf}
  ${If} $QpData == ""
    EnumRegValue $QpData ${ROOT} "${KEY}" 0
  ${EndIf}
  ${If} $QpData != ""
    IntOp $QpHitKeys $QpHitKeys + 1
    !insertmacro QP_LOGLINE "    注册表  ${KEY}"
  ${EndIf}
  ${If} $QpMode == "delete"
    DeleteRegKey ${ROOT} "${KEY}"
  ${EndIf}
!macroend

; 注册表值（删完顺手删空键）
!macro QP_REGVAL ROOT KEY VALUE
  ReadRegStr $QpData ${ROOT} "${KEY}" "${VALUE}"
  ${If} $QpData != ""
    IntOp $QpHitVals $QpHitVals + 1
    !insertmacro QP_LOGLINE "    注册表值 ${KEY} :: ${VALUE}"
  ${EndIf}
  ${If} $QpMode == "delete"
    DeleteRegValue ${ROOT} "${KEY}" "${VALUE}"
    DeleteRegKey /ifempty ${ROOT} "${KEY}"
  ${EndIf}
!macroend

; 按「值名包含某子串」批量清理。MuiCache、ApplicationAssociationToasts 这类
; 键名不确定、只有值名里带 QuillPad 的位置用它。
; 删除会让后面的值前移，所以删完不递增索引；$QpCount 兜底防死循环。
!macro QP_PURGE_VALS_BY_NAME ROOT KEY NEEDLE
  StrCpy $QpIdx 0
  StrCpy $QpCount 0
  ${Do}
    EnumRegValue $QpName ${ROOT} "${KEY}" $QpIdx
    ${If} $QpName == ""
      ${Break}
    ${EndIf}
    !insertmacro QP_STRSTR "$QpName" "${NEEDLE}" "$QpPos"
    ${If} $QpPos != ""
      IntOp $QpHitVals $QpHitVals + 1
      !insertmacro QP_LOGLINE "    注册表值 ${KEY} :: $QpName"
      ${If} $QpMode == "delete"
        DeleteRegValue ${ROOT} "${KEY}" "$QpName"
      ${Else}
        IntOp $QpIdx $QpIdx + 1
      ${EndIf}
    ${Else}
      IntOp $QpIdx $QpIdx + 1
    ${EndIf}
    IntOp $QpCount $QpCount + 1
    ${If} $QpCount > 2000
      ${Break}
    ${EndIf}
  ${Loop}
!macroend

; 按「值数据包含某子串」批量清理（OpenWithList 的 a/b/c 槽位存的是 exe 名）
!macro QP_PURGE_VALS_BY_DATA ROOT KEY NEEDLE
  StrCpy $QpIdx 0
  StrCpy $QpCount 0
  ${Do}
    EnumRegValue $QpName ${ROOT} "${KEY}" $QpIdx
    ${If} $QpName == ""
      ${Break}
    ${EndIf}
    ReadRegStr $QpA ${ROOT} "${KEY}" "$QpName"
    !insertmacro QP_STRSTR "$QpA" "${NEEDLE}" "$QpPos"
    ${If} $QpPos != ""
      IntOp $QpHitVals $QpHitVals + 1
      !insertmacro QP_LOGLINE "    注册表值 ${KEY} :: $QpName = $QpA"
      ${If} $QpMode == "delete"
        DeleteRegValue ${ROOT} "${KEY}" "$QpName"
      ${Else}
        IntOp $QpIdx $QpIdx + 1
      ${EndIf}
    ${Else}
      IntOp $QpIdx $QpIdx + 1
    ${EndIf}
    IntOp $QpCount $QpCount + 1
    ${If} $QpCount > 2000
      ${Break}
    ${EndIf}
  ${Loop}
!macroend

; 去掉命令行首尾引号与后面的参数，结果写回 $QpA。
; 只用 $QpD（专用游标）与 $QpB（专用字符），不碰调用方的 $QpIdx/$QpCount。
!macro QP_STRIP_CMDLINE INPUT
  StrCpy $QpA "${INPUT}"
  StrCpy $QpB $QpA 1
  ${If} $QpB == '"'
    StrCpy $QpA $QpA "" 1
    StrCpy $QpD 0
    ${Do}
      StrCpy $QpB $QpA 1 $QpD
      ${If} $QpB == '"'
        StrCpy $QpA $QpA $QpD
        ${Break}
      ${EndIf}
      ${If} $QpB == ""
        ${Break}
      ${EndIf}
      IntOp $QpD $QpD + 1
    ${Loop}
  ${Else}
    StrCpy $QpD 0
    ${Do}
      StrCpy $QpB $QpA 1 $QpD
      ${If} $QpB == " "
        StrCpy $QpA $QpA $QpD
        ${Break}
      ${EndIf}
      ${If} $QpB == ""
        ${Break}
      ${EndIf}
      IntOp $QpD $QpD + 1
    ${Loop}
  ${EndIf}
!macroend

; ------------------------------------------------------------- 文件系统痕迹
; 安装目录：历史上出现过的所有落点。RMDir /r 顺带删目录自身，空目录也能收掉。
; 别写小写变体 —— NTFS 不区分大小写，同一个目录会被数两遍。
!macro QP_SWEEP_INSTALL_DIRS
  ${If} ${RunningX64}
    ; 64 位：$PROGRAMFILES64 = C:\Program Files，$PROGRAMFILES = C:\Program Files (x86)
    !insertmacro QP_DIR "$PROGRAMFILES64\QuillPad"
    !insertmacro QP_DIR "$PROGRAMFILES\QuillPad"
  ${Else}
    !insertmacro QP_DIR "$PROGRAMFILES\QuillPad"
  ${EndIf}
  !insertmacro QP_DIR "$LOCALAPPDATA\Programs\QuillPad"
!macroend

; 用户数据与缓存（%APPDATA%\QuillPad 是 Electron userData，卸载的主要目标）
!macro QP_SWEEP_DATA_DIRS
  !insertmacro QP_DIR "$APPDATA\QuillPad"
  !insertmacro QP_DIR "$APPDATA\QuillPad-Data"
  !insertmacro QP_DIR "$LOCALAPPDATA\QuillPad"
  !insertmacro QP_DIR "$LOCALAPPDATA\quillpad-updater"
  !insertmacro QP_DIR "$LOCALAPPDATA\Temp\QuillPad"
!macroend

; 快捷方式。$DESKTOP / $SMPROGRAMS / $QUICKLAUNCH 受 SetShellVarContext 影响，
; 所以这个宏要按「当前用户」「所有用户」各跑一遍。
!macro QP_SWEEP_SHORTCUTS
  !insertmacro QP_FILE "$DESKTOP\QuillPad.lnk"
  !insertmacro QP_FILE "$SMPROGRAMS\QuillPad.lnk"
  !insertmacro QP_FILE "$SMPROGRAMS\卸载 QuillPad.lnk"
  !insertmacro QP_FILE "$SMPROGRAMS\QuillPad\QuillPad.lnk"
  !insertmacro QP_FILE "$SMPROGRAMS\QuillPad\卸载 QuillPad.lnk"
  !insertmacro QP_FILE "$SMSTARTUP\QuillPad.lnk"
  !insertmacro QP_FILE "$QUICKLAUNCH\QuillPad.lnk"
  !insertmacro QP_FILE "$QUICKLAUNCH\User Pinned\TaskBar\QuillPad.lnk"
!macroend

; 与 shell 上下文无关的零散残留（崩溃转储 / 临时文件）
!macro QP_SWEEP_STRAY_FILES
  !insertmacro QP_FILE "$LOCALAPPDATA\CrashDumps\QuillPad.exe.*.dmp"
  !insertmacro QP_FILE "$LOCALAPPDATA\Temp\QuillPad*.tmp"
!macroend

; 开始菜单里可能残留的空目录
!macro QP_SWEEP_EMPTY_DIRS
  ${If} $QpMode == "delete"
    RMDir "$SMPROGRAMS\QuillPad"
  ${EndIf}
!macroend

; ------------------------------------------------------------- 注册表痕迹
; Uninstall 子树：键名是 productName / appId / appId 派生的 GUID，各不相同，
; 所以按 DisplayName 模糊匹配，命中即删，并把 InstallLocation（或从
; UninstallString 解析出的目录）记进 $QpInstallDirs 供自定义安装路径清理。
!macro QP_SWEEP_UNINST_ROOT ROOT
  StrCpy $QpIdx 0
  StrCpy $QpCount 0
  ${Do}
    EnumRegKey $QpName ${ROOT} "${QP_UNINST_ROOT}" $QpIdx
    ${If} $QpName == ""
      ${Break}
    ${EndIf}
    IntOp $QpIdx $QpIdx + 1

    ReadRegStr $QpA ${ROOT} "${QP_UNINST_ROOT}\$QpName" "DisplayName"
    ${If} $QpA != ""
      !insertmacro QP_STRSTR "$QpA" "quillpad" "$QpPos"
      ${If} $QpPos != ""
        IntOp $QpHitKeys $QpHitKeys + 1
        !insertmacro QP_LOGLINE "    卸载项  ${ROOT}\${QP_UNINST_ROOT}\$QpName  ($QpA)"

        ; ---- 安装位置：优先 InstallLocation，其次从 UninstallString 反推 ----
        StrCpy $QpData ""
        ReadRegStr $QpData ${ROOT} "${QP_UNINST_ROOT}\$QpName" "InstallLocation"
        ${If} $QpData == ""
          ReadRegStr $QpData ${ROOT} "${QP_UNINST_ROOT}\$QpName" "UninstallString"
          ${If} $QpData != ""
            !insertmacro QP_STRIP_CMDLINE "$QpData"
            StrCpy $QpData "$QpA"
            ${GetParent} "$QpData" $QpData
          ${EndIf}
        ${EndIf}
        ${If} $QpData != ""
          StrCpy $QpInstallDirs "$QpInstallDirs|$QpData"
        ${EndIf}

        ${If} $QpMode == "delete"
          DeleteRegKey ${ROOT} "${QP_UNINST_ROOT}\$QpName"
          IntOp $QpIdx $QpIdx - 1
        ${EndIf}
      ${EndIf}
    ${EndIf}
    IntOp $QpCount $QpCount + 1
    ${If} $QpCount > 500
      ${Break}
    ${EndIf}
  ${Loop}
!macroend

!macro QP_SWEEP_UNINST_ALL
  !insertmacro QP_SWEEP_UNINST_ROOT HKCU
  ${If} ${RunningX64}
    SetRegView 64
    !insertmacro QP_SWEEP_UNINST_ROOT HKLM
    SetRegView 32
    !insertmacro QP_SWEEP_UNINST_ROOT HKLM
    SetRegView lastused
  ${Else}
    !insertmacro QP_SWEEP_UNINST_ROOT HKLM
  ${EndIf}
!macroend

; 关联 / 应用身份 / 右键菜单 / App Paths / 开机自启
!macro QP_SWEEP_REG_MAIN
  !insertmacro QP_REGKEY HKCU "Software\Classes\${QP_PROGID}"
  !insertmacro QP_REGKEY HKCU "Software\Classes\Applications\${QP_APP_EXE}"
  !insertmacro QP_REGKEY HKCU "Software\Classes\*\shell\QuillPad"
  !insertmacro QP_REGKEY HKCU "Software\Microsoft\Windows\CurrentVersion\App Paths\${QP_APP_EXE}"
  !insertmacro QP_REGKEY HKCU "${QP_APP_KEY}"
  !insertmacro QP_REGKEY HKCU "Software\${QP_APP_EXE}"
  !insertmacro QP_REGVAL HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "QuillPad"

  ; 资源管理器 / 任务栏的可见痕迹：值名里带 QuillPad 的都清掉
  !insertmacro QP_PURGE_VALS_BY_NAME HKCU "Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache" "quillpad"
  !insertmacro QP_PURGE_VALS_BY_NAME HKCU "Software\Microsoft\Windows\CurrentVersion\ApplicationAssociationToasts" "quillpad"
  !insertmacro QP_PURGE_VALS_BY_NAME HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FeatureUsage\AppSwitched" "quillpad"
!macroend

; 扩展名清单：安装端注册、卸载端清理都用这一份，谁也别想偷偷加一个。
!macro QP_EACH_EXT CALLER
  !insertmacro ${CALLER} ".txt"
  !insertmacro ${CALLER} ".md"
  !insertmacro ${CALLER} ".markdown"
  !insertmacro ${CALLER} ".log"
  !insertmacro ${CALLER} ".json"
  !insertmacro ${CALLER} ".jsonc"
  !insertmacro ${CALLER} ".js"
  !insertmacro ${CALLER} ".mjs"
  !insertmacro ${CALLER} ".cjs"
  !insertmacro ${CALLER} ".jsx"
  !insertmacro ${CALLER} ".ts"
  !insertmacro ${CALLER} ".tsx"
  !insertmacro ${CALLER} ".html"
  !insertmacro ${CALLER} ".htm"
  !insertmacro ${CALLER} ".css"
  !insertmacro ${CALLER} ".scss"
  !insertmacro ${CALLER} ".less"
  !insertmacro ${CALLER} ".xml"
  !insertmacro ${CALLER} ".svg"
  !insertmacro ${CALLER} ".yml"
  !insertmacro ${CALLER} ".yaml"
  !insertmacro ${CALLER} ".toml"
  !insertmacro ${CALLER} ".ini"
  !insertmacro ${CALLER} ".cfg"
  !insertmacro ${CALLER} ".conf"
  !insertmacro ${CALLER} ".properties"
  !insertmacro ${CALLER} ".env"
  !insertmacro ${CALLER} ".csv"
  !insertmacro ${CALLER} ".py"
  !insertmacro ${CALLER} ".java"
  !insertmacro ${CALLER} ".c"
  !insertmacro ${CALLER} ".h"
  !insertmacro ${CALLER} ".cpp"
  !insertmacro ${CALLER} ".hpp"
  !insertmacro ${CALLER} ".cs"
  !insertmacro ${CALLER} ".go"
  !insertmacro ${CALLER} ".rs"
  !insertmacro ${CALLER} ".php"
  !insertmacro ${CALLER} ".rb"
  !insertmacro ${CALLER} ".sh"
  !insertmacro ${CALLER} ".bash"
  !insertmacro ${CALLER} ".zsh"
  !insertmacro ${CALLER} ".bat"
  !insertmacro ${CALLER} ".cmd"
  !insertmacro ${CALLER} ".ps1"
  !insertmacro ${CALLER} ".sql"
  !insertmacro ${CALLER} ".lua"
  !insertmacro ${CALLER} ".vue"
  !insertmacro ${CALLER} ".tex"
  !insertmacro ${CALLER} ".rst"
!macroend

; 「打开方式」候选列表里的一项：删值、删空的 OpenWithProgids、撤销指向我们的
; UserChoice、清 OpenWithList 里指向本程序的槽位。
!macro QP_DROP_EXT EXT
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "${QP_PROGID}"
  DeleteRegKey /ifempty HKCU "Software\Classes\${EXT}\OpenWithProgids"
  DeleteRegValue HKCU "Software\Classes\Applications\${QP_APP_EXE}\SupportedTypes" "${EXT}"

  !insertmacro QP_PURGE_VALS_BY_DATA HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\OpenWithList" "quillpad"

  ${If} $QpMode == "delete"
    ReadRegStr $QpA HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\UserChoice" "ProgId"
    ${If} $QpA == "${QP_PROGID}"
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\${EXT}\UserChoice"
      !insertmacro QP_LOGLINE "    默认关联 FileExts\${EXT}\UserChoice → 已撤销"
    ${EndIf}
  ${EndIf}
!macroend

!macro QP_SWEEP_ASSOC
  !insertmacro QP_EACH_EXT QP_DROP_EXT
!macroend

; ------------------------------------------------------------------ 总闸
; 调用方只需：设 $QpMode → 调 QP_SWEEP_ALL。幂等，可先 scan 再 delete。
!macro QP_SWEEP_ALL
  !insertmacro QP_SWEEP_INSTALL_DIRS
  !insertmacro QP_SWEEP_DATA_DIRS
  !insertmacro QP_SWEEP_STRAY_FILES
  !insertmacro QP_SWEEP_SHORTCUTS
  !insertmacro QP_SWEEP_EMPTY_DIRS
  !insertmacro QP_SWEEP_REG_MAIN
  !insertmacro QP_SWEEP_ASSOC
  !insertmacro QP_SWEEP_UNINST_ALL
!macroend

!macro QP_RESET_COUNTERS
  StrCpy $QpHitDirs 0
  StrCpy $QpHitFiles 0
  StrCpy $QpHitKeys 0
  StrCpy $QpHitVals 0
  StrCpy $QpFail 0
  StrCpy $QpInstallDirs ""
!macroend
