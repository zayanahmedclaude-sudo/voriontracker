param([Parameter(Mandatory = $true)][string[]]$Path)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RestartManagerLocks {
  const int MoreData = 234;
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public int ProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  public enum AppType { Unknown, MainWindow, OtherWindow, Service, Explorer, Console, Critical = 1000 }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceShortName;
    public AppType ApplicationType; public uint AppStatus; public uint TerminalSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle, int flags, string key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle, uint fileCount, string[] files, uint appCount, IntPtr apps, uint serviceCount, string[] services);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] affected, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  public static ProcessInfo[] Find(string[] paths) {
    uint handle; var key = Guid.NewGuid().ToString("N"); var result = RmStartSession(out handle, 0, key); if (result != 0) throw new Exception("RmStartSession: " + result);
    try {
      result = RmRegisterResources(handle, (uint)paths.Length, paths, 0, IntPtr.Zero, 0, null); if (result != 0) throw new Exception("RmRegisterResources: " + result);
      uint needed = 0, count = 0, reasons = 0; result = RmGetList(handle, out needed, ref count, null, ref reasons);
      if (result == 0) return new ProcessInfo[0]; if (result != MoreData) throw new Exception("RmGetList(size): " + result);
      var entries = new ProcessInfo[needed]; count = needed; result = RmGetList(handle, out needed, ref count, entries, ref reasons); if (result != 0) throw new Exception("RmGetList(data): " + result);
      if (count == entries.Length) return entries; Array.Resize(ref entries, (int)count); return entries;
    } finally { RmEndSession(handle); }
  }
}
'@
$resolved = $Path | ForEach-Object { (Resolve-Path -LiteralPath $_).Path }
[RestartManagerLocks]::Find($resolved) | Select-Object @{n='ProcessId';e={$_.Process.ProcessId}}, AppName, ServiceShortName, ApplicationType, TerminalSessionId, Restartable
