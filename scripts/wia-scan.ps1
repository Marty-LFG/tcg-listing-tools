# scripts/wia-scan.ps1 -- headless flatbed scan for the card pre-grader (/api/scan).
#
# Windows PowerShell 5.1 + WIA COM, spike-verified against the live Epson Perfection V39 II.
# lib/scan.mjs runs this via: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
# (powershell.exe is STA by default, which WIA needs; pwsh 7 is deliberately not used -- untested).
#
# Contract with lib/scan.mjs: stdout carries EXACTLY ONE compact JSON line -- the PNG goes to -Out,
# never to stdout -- and ANY failure prints {ok:false,error,message} and exits 1. The server parses
# stdout, so a bare PowerShell error record here would surface to the browser as a raw 502 string;
# everything below runs under try/catch with $ErrorActionPreference='Stop' to make that impossible.
# NEVER WIA.CommonDialog: it pops the vendor UI, which hangs forever in a -NonInteractive host.
#
#   -Mode list                                            -> {"ok":true,"devices":[{"id","name"}]}
#   -Mode scan -Dpi 600 -Wmm 110 -Hmm 140 -Out C:\t\x.png -> {"ok":true,"w","h","dpi"}
#
# PS 5.1 compatible on purpose (no ternary, no ??, no null-conditional).
param(
  [string]$Mode = 'list',
  [int]$Dpi = 600,
  [double]$Wmm = 110,
  [double]$Hmm = 140,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

function Write-Fail([string]$code, [string]$msg) {
  Write-Output (@{ ok = $false; error = $code; message = $msg } | ConvertTo-Json -Compress)
  exit 1
}

# Manual -Mode validation instead of [ValidateSet]: a binder error would print a plain error
# record and exit before any of our JSON, breaking the one-line stdout protocol.
if ($Mode -ne 'list' -and $Mode -ne 'scan') { Write-Fail 'scan_failed' ('unknown -Mode "' + $Mode + '" (list|scan)') }

try {
  $dm = New-Object -ComObject WIA.DeviceManager
} catch {
  # No WIA at all (service disabled / not Windows-with-WIA) reads the same as no scanner to the caller.
  Write-Fail 'no_scanner' ('WIA unavailable: ' + $_.Exception.Message)
}

# Type 1 = scanner (cameras/video devices enumerate here too; we never want them).
$infos = @()
try {
  $infos = @($dm.DeviceInfos | Where-Object { $_.Type -eq 1 })
} catch {
  Write-Fail 'no_scanner' ('WIA enumeration failed: ' + $_.Exception.Message)
}

if ($Mode -eq 'list') {
  $devices = @()
  foreach ($di in $infos) {
    $name = 'WIA scanner'
    try { $name = [string]$di.Properties.Item('Name').Value } catch { }
    $devices += @{ id = [string]$di.DeviceID; name = $name }
  }
  Write-Output (@{ ok = $true; devices = $devices } | ConvertTo-Json -Compress -Depth 4)
  exit 0
}

# ---- scan ----
if (-not $Out) { Write-Fail 'scan_failed' 'missing -Out path' }
if ($Wmm -le 0 -or $Hmm -le 0) { Write-Fail 'scan_failed' 'region must be positive (-Wmm/-Hmm)' }
if ($infos.Count -lt 1) { Write-Fail 'no_scanner' 'no WIA scanner connected' }

# $stage prefixes the failure message: WIA COM errors are generic ("Specified cast is not
# valid", HRESULT soup) and the only way to know WHICH call threw on a remote report.
$stage = 'connect'
try {
  $item = $infos[0].Connect().Items.Item(1)
  $p = $item.Properties

  # Clamp the requested DPI to what the driver declares (V39 II: min 50, max 1200). Read the
  # bounds off the property itself so a different unit still lands in range; fall back to the
  # measured V39 II bounds if a driver refuses to report them.
  $minDpi = 50; $maxDpi = 1200
  try { $minDpi = [int]$p.Item('6147').SubTypeMin; $maxDpi = [int]$p.Item('6147').SubTypeMax } catch { }
  $useDpi = $Dpi
  if ($useDpi -lt $minDpi) { $useDpi = $minDpi }
  if ($useDpi -gt $maxDpi) { $useDpi = $maxDpi }

  # CRITICAL ORDER: resolution FIRST, extents LAST. 6151/6152 are in PIXELS AT THE SET DPI and
  # their SubTypeMax scales with it (850x1170 at the default 100dpi -> 5100x7020 at 600), so the
  # extent ceiling read before the resolution write would be the WRONG ceiling.
  $stage = 'set-props'
  $p.Item('6147').Value = $useDpi   # X resolution
  $p.Item('6148').Value = $useDpi   # Y resolution
  $p.Item('4103').Value = 3         # datatype: color
  $p.Item('6149').Value = 0         # X start (glass origin, top-left)
  $p.Item('6150').Value = 0         # Y start

  $stage = 'set-extent'
  $wPx = [int][Math]::Round($Wmm / 25.4 * $useDpi)
  $hPx = [int][Math]::Round($Hmm / 25.4 * $useDpi)
  if ($wPx -lt 1) { $wPx = 1 }
  if ($hPx -lt 1) { $hPx = 1 }
  try {
    $maxW = [int]$p.Item('6151').SubTypeMax   # re-read AFTER the resolution write (see above)
    $maxH = [int]$p.Item('6152').SubTypeMax
    if ($maxW -gt 0 -and $wPx -gt $maxW) { $wPx = $maxW }
    if ($maxH -gt 0 -and $hPx -gt $maxH) { $hPx = $maxH }
  } catch { }
  $p.Item('6151').Value = $wPx      # X extent (pixels at $useDpi)
  $p.Item('6152').Value = $hPx      # Y extent

  # Transfer as BMP -- the one format every WIA driver honors (asking the driver for PNG directly
  # is a lottery) -- then convert to PNG in software via the ImageProcess 'Convert' filter.
  $fmtBmp = '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}'
  $fmtPng = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'
  $stage = 'transfer'
  $img = $item.Transfer($fmtBmp)

  $stage = 'convert'
  $ip = New-Object -ComObject WIA.ImageProcess
  $ip.Filters.Add($ip.FilterInfos.Item('Convert').FilterID)
  # The [string] cast is LOAD-BEARING: PS 5.1's COM binder fails a STRING property-put with
  # "Specified cast is not valid" when the RHS is a bare variable (a literal, or a [string]
  # cast, marshals fine — as do int property-puts and string METHOD arguments). Bisected on
  # the live V39 II; do not "simplify" it away.
  $ip.Filters.Item(1).Properties.Item('FormatID').Value = [string]$fmtPng
  $img = $ip.Apply($img)

  # ImageFile.SaveFile REFUSES an existing path (0x80070050), so pre-delete. lib/scan.mjs hands us
  # a unique temp name, but a crashed previous run can leave one behind.
  $stage = 'save'
  if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
  $img.SaveFile($Out)

  Write-Output (@{ ok = $true; w = [int]$img.Width; h = [int]$img.Height; dpi = $useDpi } | ConvertTo-Json -Compress)
  exit 0
} catch {
  Write-Fail 'scan_failed' ($stage + ': ' + $_.Exception.Message)
}
