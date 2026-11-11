# Keeps every top-level window of the MCP's dedicated browser hidden (no window,
# no taskbar button) while the browser itself runs as a normal, non-headless
# instance. Exits on its own once that browser has quit.
param([Parameter(Mandatory = $true)][string]$ProfileDir, [string]$VisibleFlag = "")

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FlowHide {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  public static int HideFor(HashSet<uint> pids) {
    int hidden = 0;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h)) { ShowWindow(h, 0); hidden++; }
      return true;
    }, IntPtr.Zero);
    return hidden;
  }
}
"@

# Only the browser's own processes carry --user-data-dir=<profile> on their command line.
$needle = ('user-data-dir=' + $ProfileDir.Replace('/', '\').TrimEnd('\')).ToLowerInvariant()
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
$lastScan = [DateTime]::MinValue
$emptySince = $null

while ($true) {
  # The MCP switched the browser to a visible window (Google sign-in): stop hiding.
  if ($VisibleFlag -and (Test-Path -LiteralPath $VisibleFlag)) { break }
  $scanEvery = if ($pids.Count -eq 0) { 250 } else { 1500 }  # fast until the browser shows up
  if (([DateTime]::Now - $lastScan).TotalMilliseconds -ge $scanEvery) {
    $pids.Clear()
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch '^(powershell|pwsh)\.exe$' -and $_.CommandLine -and $_.CommandLine.Replace('"', '').Replace('/', '\').ToLowerInvariant().Contains($needle) } |
      ForEach-Object { [void]$pids.Add([uint32]$_.ProcessId) }
    $lastScan = [DateTime]::Now
    if ($pids.Count -eq 0) {
      if (-not $emptySince) { $emptySince = [DateTime]::Now }
      elseif (([DateTime]::Now - $emptySince).TotalSeconds -gt 20) { break }
    } else { $emptySince = $null }
  }
  if ($pids.Count -gt 0) { [void][FlowHide]::HideFor($pids) }
  Start-Sleep -Milliseconds 60
}
