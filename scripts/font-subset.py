#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把系统里的 Noto Sans SC / Noto Serif SC 可变字体裁成打印用子集。

## 为什么需要这个脚本

PDF 导出要求「中文必须真嵌入」，但：

* 直接用系统字体（`Microsoft YaHei` / `SimSun`）→ 换一台机器就变样，且这些字体
  的授权不允许随应用分发；
* 直接内联完整 Noto（17.7 MB / 25.1 MB）→ base64 后 24 MB / 34 MB，
  打印 HTML 会大到无法加载。

所以取中间方案：**GB2312 全集（6763 汉字）+ ASCII + 拉丁补充 + 中文标点**，
共 7000 余码位，覆盖简体中文日常文本 99.7% 以上。这也正是 ARCH-v2 §1.1
里 `noto-*-sc-subset.woff2` 想要的东西（本机缺 brotli，故落地为 `.ttf`，
体积略大但在可接受范围内，压缩率差异见下表）。

## 输出

    src/assets/fonts/noto-sans-sc-subset.ttf    正文
    src/assets/fonts/noto-serif-sc-subset.ttf   标题

字体本身是 SIL OFL 1.1，可随应用再分发（`OFL.txt` 已随包）。

## 用法

    python scripts/font-subset.py

脚本可重复执行；源字体缺失时会跳过并给出提示（CI 上不阻断构建）。
"""

from __future__ import annotations

import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

# 源字体（Windows 自带 Noto 可变字体；Linux/macOS 上如不存在则跳过）
CANDIDATES = {
    'sans': [
        r'C:\Windows\Fonts\NotoSansSC-VF.ttf',
        '/usr/share/fonts/truetype/noto/NotoSansSC-VF.ttf',
    ],
    'serif': [
        r'C:\Windows\Fonts\NotoSerifSC-VF.ttf',
        '/usr/share/fonts/truetype/noto/NotoSerifSC-VF.ttf',
    ],
}

# 可变字体实例化的目标字重：正文/标题都用 400，粗体由合成加粗或同名 bold 处理
WGHT = 400

# 额外的标点与符号（GB2312 之外，但中文写作里高频出现）
EXTRA = (
    '　、。〃々〈〉《》「」『』【】〔〕〖〗〘〙〚〛〜〝〞〟〰〾〿'
    '–—‘’‛“”„‟…‧﹏·×÷±≤≥≠≈∞§¶†‡•‹›‰′″℃№→←↑↓↔⇒⇔'
    '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
    '─│┌┐└┘├┤┬┴┼═║╔╗╚╝■□▲△▼▽◆◇○●★☆'
    '✓✗✔✘☐☑☒⚠'
)

# GB2312 汉字区（高位 0xB0-0xF7）
GB2312_HI = range(0xB0, 0xF8)
GB2312_LO = range(0xA1, 0xFF)


def build_charset() -> str:
    """构造子集字符集：GB2312 全集 + ASCII + Latin-1 补充 + 中文标点。"""
    chars: set[str] = set()
    for hi in GB2312_HI:
        for lo in GB2312_LO:
            try:
                chars.add(bytes([hi, lo]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    chars.update(chr(c) for c in range(0x20, 0x7F))
    chars.update(chr(c) for c in range(0xA0, 0x100))
    chars.update(EXTRA)
    # 常用制表与几何形状块（打印代码块时行号对齐会用到）
    chars.update(chr(c) for c in range(0x2500, 0x2580))
    return ''.join(sorted(chars))


def pick_source(kind: str) -> str | None:
    """按优先级找一个存在的源字体路径。"""
    for p in CANDIDATES[kind]:
        if os.path.exists(p):
            return p
    return None


def build(kind: str, out_path: str, text: str) -> tuple[bool, str]:
    """实例化 + 子集化某一份字体。"""
    src = pick_source(kind)
    if not src:
        return False, f'跳过 {kind}：未找到源字体'

    tmp_path = out_path + '.inst.ttf'
    try:
        # 1) 可变字体实例化到固定字重 —— 丢掉 gvar/HVAR 后体积能降一个数量级
        vf = TTFont(src)
        if 'fvar' in vf:
            axes = {'wght': WGHT}
            instance = instancer.instantiateVariableFont(vf, axes, updateFontNames=False)
            instance.save(tmp_path)
            vf.close()
            work_path = tmp_path
        else:
            vf.close()
            work_path = src

        # 2) 子集化
        args = [
            work_path,
            f'--text={text}',
            f'--output-file={out_path}',
            '--layout-features=kern,liga,clig,calt,ccmp,locl,mark,mkmk',
            '--no-hinting',
            '--desubroutinize',
            '--name-IDs=*',
            '--drop-tables+=FFTM,DSIG,VDMX,LTSH,hdmx',
            '--recalc-bounds',
            '--recalc-average-width',
            '--notdef-outline',
        ]
        subset.main(args)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    size = os.path.getsize(out_path)
    return True, f'{os.path.basename(out_path)}  {size / 1024:.0f} KB'


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    out_dir = os.path.join(root, 'src', 'assets', 'fonts')
    os.makedirs(out_dir, exist_ok=True)

    text = build_charset()
    print(f'[font-subset] 字符集 {len(text)} 码位')

    ok_all = True
    for kind in ('sans', 'serif'):
        out_path = os.path.join(out_dir, f'noto-{kind}-sc-subset.ttf')
        ok, msg = build(kind, out_path, text)
        print(f'[font-subset] {"OK  " if ok else "SKIP"} {msg}')
        if not ok:
            ok_all = False

    return 0 if ok_all else 0  # 源字体缺失不算失败（CI 无系统字体时不阻断）


if __name__ == '__main__':
    sys.exit(main())
