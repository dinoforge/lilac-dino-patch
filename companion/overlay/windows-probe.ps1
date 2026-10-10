# Read-only Windows top-level window metadata. Run only after explicit user opt-in.
# Does not inspect process memory, files, cookies or other user data.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LilacOverlayWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT rect, int size);
}
'@
$result = @()
$foreground = [LilacOverlayWin32]::GetForegroundWindow().ToInt64()
Get-Process -Name 'LilacAnime' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $_
  try {
    $h = $p.MainWindowHandle
    if ($h -eq [IntPtr]::Zero -or -not [LilacOverlayWin32]::IsWindowVisible($h)) { return }
    if ([LilacOverlayWin32]::IsIconic($h)) { return }
    if ($p.MainWindowTitle -ne 'LilacAnime') { return }
    $r = New-Object 'LilacOverlayWin32+RECT'
    $ok = [LilacOverlayWin32]::DwmGetWindowAttribute($h, 9, [ref]$r, [Runtime.InteropServices.Marshal]::SizeOf([type]'LilacOverlayWin32+RECT'))
    if ($ok -ne 0) { [void][LilacOverlayWin32]::GetWindowRect($h, [ref]$r) }
    $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
    if ($w -le 0 -or $ht -le 0) { return }
    $result += [pscustomobject]@{
      pid = [int]$p.Id
      hwnd = [string]$h.ToInt64()
      title = [string]$p.MainWindowTitle
      foreground = ($h.ToInt64() -eq $foreground)
      rect = [pscustomobject]@{ x = [int]$r.Left; y = [int]$r.Top; width = [int]$w; height = [int]$ht }
    }
  } catch { }
}
[pscustomobject]@{ windows = @($result) } | ConvertTo-Json -Compress -Depth 5
