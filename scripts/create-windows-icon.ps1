$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root 'public/assets/aistudio/icon.png'
$outputDir = Join-Path $root 'build'
$outputPath = Join-Path $outputDir 'abkrino.ico'
$tempPng = Join-Path $env:TEMP ("abkrino-icon-" + [guid]::NewGuid().ToString('N') + '.png')

if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Original Abkrino icon not found: $sourcePath"
}
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$source = [System.Drawing.Image]::FromFile($sourcePath)
$canvas = New-Object System.Drawing.Bitmap(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    $scale = [Math]::Min(256.0 / $source.Width, 256.0 / $source.Height)
    $width = [Math]::Max(1, [int][Math]::Round($source.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($source.Height * $scale))
    $x = [int][Math]::Floor((256 - $width) / 2)
    $y = [int][Math]::Floor((256 - $height) / 2)
    $graphics.DrawImage($source, $x, $y, $width, $height)
    $canvas.Save($tempPng, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
    $graphics.Dispose()
    $canvas.Dispose()
    $source.Dispose()
}

$pngBytes = [System.IO.File]::ReadAllBytes($tempPng)
$stream = [System.IO.File]::Open($outputPath, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter($stream)
try {
    # ICO header + one 256x256 PNG-backed image entry.
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]1)
    $writer.Write([Byte]0)
    $writer.Write([Byte]0)
    $writer.Write([Byte]0)
    $writer.Write([Byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$pngBytes.Length)
    $writer.Write([UInt32]22)
    $writer.Write($pngBytes)
}
finally {
    $writer.Dispose()
    $stream.Dispose()
    Remove-Item -LiteralPath $tempPng -Force -ErrorAction SilentlyContinue
}
Write-Host "Created valid 256x256 Abkrino ICO: $outputPath"
