$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'public\assets\aistudio\icon.png'
$outputDir = Join-Path $root 'build'
$output = Join-Path $outputDir 'abkrino.ico'

if (-not (Test-Path -LiteralPath $source)) {
  throw "Original Abkrino icon not found: $source"
}
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$original = [System.Drawing.Image]::FromFile($source)
try {
  $bitmap = New-Object System.Drawing.Bitmap 256, 256, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($original, 0, 0, 256, 256)
    } finally { $graphics.Dispose() }
    $memory = New-Object System.IO.MemoryStream
    try {
      $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
      $png = $memory.ToArray()
    } finally { $memory.Dispose() }
  } finally { $bitmap.Dispose() }
} finally { $original.Dispose() }

# ICO directory containing a 256x256 PNG-backed image (Windows 7+).
$stream = [System.IO.File]::Create($output)
try {
  $writer = New-Object System.IO.BinaryWriter($stream)
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]1)
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$png.Length)
  $writer.Write([UInt32]22)
  $writer.Write($png)
  $writer.Flush()
} finally { $stream.Dispose() }

Write-Host "Created $output"
