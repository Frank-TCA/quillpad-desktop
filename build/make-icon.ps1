# QuillPad icon generator (System.Drawing, no external deps).
# Renders the brand mark (aurora gradient rounded square + quill stroke) at
# several sizes, then the Node packer turns them into a multi-size .ico.
# All comments in English on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI.

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot      # project root
$buildDir = $PSScriptRoot
$sizeDir = Join-Path $buildDir 'icon-sizes'

if (Test-Path $sizeDir) { Remove-Item $sizeDir -Recurse -Force }
New-Item -ItemType Directory -Path $sizeDir | Out-Null

# Draw the mark at an arbitrary resolution.
function New-QuillBitmap {
    param([int]$Size)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded-square geometry (radius = 22% of side, matches the favicon's 8/32).
    $r = [float]($Size * 0.22)
    $d = [float]($r * 2)
    $rect = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($Size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $Size - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $c1 = [System.Drawing.Color]::FromArgb(255, 0x6e, 0xa8, 0xfe)
    $c2 = [System.Drawing.Color]::FromArgb(255, 0xb4, 0x8c, 0xff)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45.0)
    $g.FillPath($brush, $path)
    $brush.Dispose()

    # Quill mark: a pointed leaf outline (the vane) plus a short shaft (the nib).
    # Authored on a 512 grid and scaled, so every size keeps the same silhouette.
    $u = [float]($Size / 512.0)
    $pt = {
        param([double]$x, [double]$y)
        New-Object System.Drawing.PointF([float]($x * $u), [float]($y * $u))
    }

    $tip = & $pt 382 118          # feather tip (upper right)
    $base = & $pt 176 322         # where the vane meets the shaft (lower left)

    # Two symmetric control pairs bow the outline into a leaf shape.
    $c1 = & $pt 300 62
    $c2 = & $pt 122 214
    $c3 = & $pt 250 388
    $c4 = & $pt 430 226

    $vane = New-Object System.Drawing.Drawing2D.GraphicsPath
    $vane.AddBezier($tip, $c1, $c2, $base)
    $vane.AddBezier($base, $c3, $c4, $tip)
    $vane.CloseFigure()

    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float](26 * $u))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $nib = & $pt 140 360
    $g.DrawPath($pen, $vane)
    $g.DrawLine($pen, $base, $nib)

    $pen.Dispose()
    $vane.Dispose()
    $path.Dispose()
    $g.Dispose()

    return $bmp
}

# Master asset: 512px PNG (also used as the Linux/generic icon).
$master = New-QuillBitmap -Size 512
$master.Save((Join-Path $buildDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$master.Dispose()

# Per-size PNGs for the .ico container.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
foreach ($sz in $sizes) {
    $bmp = New-QuillBitmap -Size $sz
    $out = Join-Path $sizeDir ("icon-{0}.png" -f $sz)
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

Write-Output ("generated icon.png + {0} sizes in {1}" -f $sizes.Count, $sizeDir)
