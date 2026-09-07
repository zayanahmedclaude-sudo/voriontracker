using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

if (args.Contains("--install")) { try { await AdminActions.Install(args); } catch(Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode=1; } return; }
if (args.Contains("--stop")) { AdminActions.Elevate("--stop-elevated"); return; }
if (args.Contains("--uninstall")) { AdminActions.Elevate("--uninstall-elevated"); return; }
if (args.Contains("--stop-elevated")) { AdminActions.RequireAdministrator(); AdminActions.RunSc("stop", AppConstants.ServiceName); return; }
if (args.Contains("--uninstall-elevated")) { AdminActions.RequireAdministrator(); AdminActions.RunSc("stop", AppConstants.ServiceName); AdminActions.RunSc("delete", AppConstants.ServiceName); QueueStore.DeleteAll(); SecretStore.Delete(); return; }

var agentIndex = Array.IndexOf(args, "--agent");
if (agentIndex < 0 || agentIndex + 1 >= args.Length) throw new ArgumentException("--agent path is required");
var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = AppConstants.ServiceName);
builder.Services.AddSingleton(new SupervisorOptions(Path.GetFullPath(args[agentIndex + 1])));
builder.Services.AddHostedService<SupervisorWorker>();
await builder.Build().RunAsync();

sealed record SupervisorOptions(string AgentPath);
static class AppConstants { public const string ServiceName = "VorionTrackerSupervisor"; }

sealed class SupervisorWorker(SupervisorOptions options, ILogger<SupervisorWorker> logger) : BackgroundService {
  readonly object gate = new(); Process? agent; DateTime lastHeartbeat = DateTime.MinValue; DateTime launchedAt = DateTime.MinValue; DateTime nextLaunchAt = DateTime.MinValue; int expectedPid; int expectedSessionId = -1; int crashCount;
  protected override async Task ExecuteAsync(CancellationToken stoppingToken) {
    _ = Task.Run(() => PipeLoop(stoppingToken), stoppingToken);
    while (!stoppingToken.IsCancellationRequested) {
      try {
      {
        var activeSessionId = InteractiveProcess.GetActiveSessionId();
        if (activeSessionId < 0) {
          bool wasRunning; lock (gate) wasRunning = agent != null;
          if (wasRunning) { logger.LogInformation("No active interactive Windows session; stopping capture process"); StopAgent(); }
          crashCount=0; nextLaunchAt=DateTime.MinValue;
          await Task.Delay(2000, stoppingToken); continue;
        }
        bool restart; bool sessionChanged;
        lock (gate) { sessionChanged=expectedSessionId>=0&&expectedSessionId!=activeSessionId; restart=agent==null||agent.HasExited||sessionChanged||(lastHeartbeat!=DateTime.MinValue&&DateTime.UtcNow-lastHeartbeat>TimeSpan.FromSeconds(7)); }
        if (restart && DateTime.UtcNow >= nextLaunchAt) {
          var lifetime = launchedAt == DateTime.MinValue ? TimeSpan.Zero : DateTime.UtcNow-launchedAt;
          crashCount = sessionChanged||launchedAt==DateTime.MinValue||lifetime>=TimeSpan.FromMinutes(1) ? 0 : Math.Min(crashCount+1, 6);
          var delay = crashCount==0 ? TimeSpan.Zero : TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, Math.Max(1, crashCount))));
          StopAgent(); nextLaunchAt=DateTime.UtcNow+delay;
          if(delay>TimeSpan.Zero){logger.LogWarning("Capture process unavailable; restart attempt {Attempt} in {Delay}s",crashCount,delay.TotalSeconds);await Task.Delay(delay, stoppingToken);}
          LaunchAgent(activeSessionId);
        }
      }
      } catch (Exception e) { logger.LogError(e,"Supervisor iteration failed"); }
      await Task.Delay(2000, stoppingToken);
    }
  }
  void LaunchAgent(int sessionId) {
    if (!File.Exists(options.AgentPath)) throw new FileNotFoundException("Capture agent missing", options.AgentPath);
    var pid = InteractiveProcess.Launch(options.AgentPath, "--supervised", sessionId);
    lock (gate) { expectedPid=pid; expectedSessionId=sessionId; agent=Process.GetProcessById(pid); lastHeartbeat=DateTime.UtcNow; launchedAt=DateTime.UtcNow; nextLaunchAt=DateTime.MinValue; }
    logger.LogInformation("Capture agent launched as PID {Pid} in session {SessionId}",pid,sessionId);
  }
  void StopAgent() { lock(gate){try{if(agent is {HasExited:false})agent.Kill(true);}catch{} agent?.Dispose();agent=null;expectedPid=0;expectedSessionId=-1;lastHeartbeat=DateTime.MinValue;} }
  async Task PipeLoop(CancellationToken token) {
    while (!token.IsCancellationRequested) {
      var security=new PipeSecurity(); security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),PipeAccessRights.FullControl,AccessControlType.Allow)); security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null),PipeAccessRights.FullControl,AccessControlType.Allow)); security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid,null),PipeAccessRights.ReadWrite,AccessControlType.Allow));
      await using var pipe=NamedPipeServerStreamAcl.Create("vorion-tracker-service",PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,security);
      await pipe.WaitForConnectionAsync(token); Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out var clientPid);
      int allowed; lock(gate)allowed=expectedPid; if(clientPid!=(uint)allowed){pipe.Disconnect();continue;}
      using var reader=new StreamReader(pipe,Encoding.UTF8,false,4096,true); await using var writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true){AutoFlush=true};
      var line=await reader.ReadLineAsync(token); if(string.IsNullOrWhiteSpace(line))continue;
      string requestId="unknown";
      try { if(line.Length>16*1024*1024)throw new InvalidDataException("Supervisor IPC message is too large");using var doc=JsonDocument.Parse(line); var root=doc.RootElement; requestId=root.GetProperty("id").GetString()??"unknown"; var payload=root.GetProperty("payload"); var command=payload.GetProperty("command").GetString(); object result;
        if(command=="agent-heartbeat"){if(payload.GetProperty("pid").GetInt32()!=allowed)throw new UnauthorizedAccessException();int session;lock(gate){lastHeartbeat=DateTime.UtcNow;session=expectedSessionId;}result=new{ok=true,locked=InteractiveProcess.IsSessionLocked(session)};}
        else if(command=="get-device-token"){if(payload.GetProperty("pid").GetInt32()!=allowed)throw new UnauthorizedAccessException();var enrollment=SecretStore.Read();result=new{token=enrollment.Token,serverUrl=enrollment.ServerUrl};}
        else if(command=="queue-upsert"){RequireExpectedPid(payload,allowed);QueueStore.Upsert(payload.GetProperty("record"));result=new{stored=true};}
        else if(command=="queue-list"){RequireExpectedPid(payload,allowed);var limit=payload.TryGetProperty("limit",out var requested)?requested.GetInt32():20;result=new{records=QueueStore.List(Math.Clamp(limit,1,20)),quotaBytes=QueueStore.MaxBytes,maxRecords=QueueStore.MaxRecords};}
        else if(command=="queue-delete"){RequireExpectedPid(payload,allowed);QueueStore.Delete(payload.GetProperty("localId").GetString()??"");result=new{deleted=true};}
        else if(command=="ping")result=new{mode="supervisor",ok=true}; else throw new InvalidOperationException("Unsupported supervisor command");
        await writer.WriteLineAsync(JsonSerializer.Serialize(new{id=requestId,ok=true,result}));
      } catch(Exception e){logger.LogWarning("Rejected supervisor IPC command: {Reason}",e.Message);await writer.WriteLineAsync(JsonSerializer.Serialize(new{id=requestId,ok=false,error=e.Message}));}
    }
  }
  static void RequireExpectedPid(JsonElement payload,int expectedPid){if(!payload.TryGetProperty("pid",out var pid)||pid.GetInt32()!=expectedPid)throw new UnauthorizedAccessException();}
  public override Task StopAsync(CancellationToken token){StopAgent();return base.StopAsync(token);}
}

static class SecretStore {
  static readonly string Root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"VorionTracker","secure"); static readonly string FilePath=Path.Combine(Root,"device-token.bin");
  public static void ProtectDirectory(string path){var system=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);var admins=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null);var security=new DirectorySecurity();security.SetAccessRuleProtection(true,false);security.AddAccessRule(new FileSystemAccessRule(system,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));security.AddAccessRule(new FileSystemAccessRule(admins,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));new DirectoryInfo(path).SetAccessControl(security);}
  public static void Write(string token,string serverUrl){Directory.CreateDirectory(Root);ProtectDirectory(Root);var value=JsonSerializer.Serialize(new Enrollment(token,serverUrl));File.WriteAllBytes(FilePath,ProtectedData.Protect(Encoding.UTF8.GetBytes(value),null,DataProtectionScope.LocalMachine));var fileSecurity=new FileSecurity();fileSecurity.SetAccessRuleProtection(true,false);fileSecurity.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),FileSystemRights.FullControl,AccessControlType.Allow));fileSecurity.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null),FileSystemRights.FullControl,AccessControlType.Allow));new FileInfo(FilePath).SetAccessControl(fileSecurity);}
  public static Enrollment Read(){var bytes=File.ReadAllBytes(FilePath);var value=Encoding.UTF8.GetString(ProtectedData.Unprotect(bytes,null,DataProtectionScope.LocalMachine));if(value.StartsWith("vrt_dev_",StringComparison.Ordinal))return new Enrollment(value,"https://api.vorionsystems.com");return JsonSerializer.Deserialize<Enrollment>(value)??throw new InvalidDataException("Stored enrollment is invalid");}
  public sealed record Enrollment(string Token,string ServerUrl);
  public static void Delete(){if(File.Exists(FilePath))File.Delete(FilePath);if(Directory.Exists(Root)&&!Directory.EnumerateFileSystemEntries(Root).Any())Directory.Delete(Root);}
}

static class QueueStore {
  public const long MaxBytes=1024L*1024*1024;
  public const int MaxRecords=2000;
  static readonly string Root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),"VorionTracker","secure","screenshot-queue");
  static readonly byte[] Entropy=Encoding.UTF8.GetBytes("VorionTrackerScreenshotQueueV1");
  static string PathFor(string localId){if(!System.Text.RegularExpressions.Regex.IsMatch(localId,"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$"))throw new InvalidDataException("Invalid queue localId");return Path.Combine(Root,Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(localId)))+".vq");}
  static void EnsureRoot(){Directory.CreateDirectory(Root);SecretStore.ProtectDirectory(Root);}
  public static void Upsert(JsonElement record){Validate(record);EnsureRoot();var localId=record.GetProperty("localId").GetString()!;var path=PathFor(localId);var clear=Encoding.UTF8.GetBytes(record.GetRawText());if(clear.Length>12*1024*1024)throw new InvalidDataException("Queue record exceeds 12 MiB");var encrypted=ProtectedData.Protect(clear,Entropy,DataProtectionScope.LocalMachine);var files=new DirectoryInfo(Root).GetFiles("*.vq");var existing=files.FirstOrDefault(file=>file.FullName.Equals(path,StringComparison.OrdinalIgnoreCase));var projected=files.Sum(file=>file.Length)-(existing?.Length??0)+encrypted.Length;if((existing==null&&files.Length>=MaxRecords)||projected>MaxBytes)throw new IOException("Protected screenshot queue quota reached");var temp=path+"."+Guid.NewGuid().ToString("N")+".tmp";try{using(var stream=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.WriteThrough)){stream.Write(encrypted);stream.Flush(true);}File.Move(temp,path,true);}finally{if(File.Exists(temp))File.Delete(temp);}}
  public static object[] List(int limit){EnsureRoot();var records=new List<object>();foreach(var file in new DirectoryInfo(Root).GetFiles("*.vq").OrderBy(file=>file.LastWriteTimeUtc).Take(limit)){try{var clear=ProtectedData.Unprotect(File.ReadAllBytes(file.FullName),Entropy,DataProtectionScope.LocalMachine);using var doc=JsonDocument.Parse(clear);Validate(doc.RootElement);records.Add(JsonSerializer.Deserialize<object>(doc.RootElement.GetRawText())!);}catch(Exception error){Console.Error.WriteLine($"[QUEUE] Could not read protected queue record {file.Name}: {error.Message}");}}return records.ToArray();}
  public static void Delete(string localId){EnsureRoot();var path=PathFor(localId);if(File.Exists(path))File.Delete(path);}
  public static void DeleteAll(){if(Directory.Exists(Root))Directory.Delete(Root,true);}
  static void RejectCredentialFields(JsonElement element){if(element.ValueKind==JsonValueKind.Object){foreach(var property in element.EnumerateObject()){var name=property.Name.ToLowerInvariant();if(name.Contains("token")||name.Contains("authorization")||name.Contains("password"))throw new InvalidDataException("Credentials are forbidden in queue records");RejectCredentialFields(property.Value);}}else if(element.ValueKind==JsonValueKind.Array){foreach(var item in element.EnumerateArray())RejectCredentialFields(item);}}
  static void Validate(JsonElement record){if(record.ValueKind!=JsonValueKind.Object)throw new InvalidDataException("Queue record must be an object");RejectCredentialFields(record);var localId=record.GetProperty("localId").GetString()??"";PathFor(localId);if(!record.TryGetProperty("capturedAt",out var captured)||!DateTimeOffset.TryParse(captured.GetString(),out _))throw new InvalidDataException("Invalid capturedAt");var context=record.GetProperty("captureContext").GetString();if(context!="employee_session"&&context!="device_background")throw new InvalidDataException("Invalid capture context");var sessionId=record.TryGetProperty("sessionId",out var session)&&session.ValueKind==JsonValueKind.String?session.GetString():null;var employeeId=record.TryGetProperty("employeeId",out var employee)&&employee.ValueKind==JsonValueKind.String?employee.GetString():null;var deviceId=record.TryGetProperty("deviceRegistrationId",out var device)&&device.ValueKind==JsonValueKind.String?device.GetString():null;if(context=="employee_session"&&(string.IsNullOrWhiteSpace(sessionId)||string.IsNullOrWhiteSpace(employeeId)||!string.IsNullOrWhiteSpace(deviceId)))throw new InvalidDataException("Invalid employee queue provenance");if(context=="device_background"&&(!string.IsNullOrWhiteSpace(sessionId)||!string.IsNullOrWhiteSpace(employeeId)||string.IsNullOrWhiteSpace(deviceId)))throw new InvalidDataException("Invalid device queue provenance");}
}

static class AdminActions {
  public static void RequireAdministrator(){using var id=WindowsIdentity.GetCurrent();if(!new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator))throw new UnauthorizedAccessException("Administrator elevation is required");}
  public static void Elevate(string action){var exe=Environment.ProcessPath!;Process.Start(new ProcessStartInfo(exe,action){UseShellExecute=true,Verb="runas"})?.WaitForExit();}
  public static async Task Install(string[] args){RequireAdministrator();var token=Environment.GetEnvironmentVariable("VORION_DEVICE_TOKEN")??"";Environment.SetEnvironmentVariable("VORION_DEVICE_TOKEN",null);var agent=Path.GetFullPath(Value(args,"--agent"));var server=OptionalValue(args,"--server")??"https://api.vorionsystems.com";if(string.IsNullOrWhiteSpace(token))token=await WaitForAdminApproval(server);else await ValidateEnrollment(server,token);SecretStore.Write(token,server);var exe=Environment.ProcessPath!;try{RunSc("stop",AppConstants.ServiceName);}catch{}try{RunSc("delete",AppConstants.ServiceName);Thread.Sleep(1500);}catch{}RunSc("create",AppConstants.ServiceName,"binPath=",$"\"{exe}\" --service --agent \"{agent}\"","start=","delayed-auto","obj=","LocalSystem","DisplayName=","Vorion Tracker Supervisor");RunSc("description",AppConstants.ServiceName,"Protected supervisor for the Vorion interactive capture agent.");RunSc("failure",AppConstants.ServiceName,"reset=","86400","actions=","restart/5000/restart/15000/restart/30000");RunSc("failureflag",AppConstants.ServiceName,"1");RunSc("sdset",AppConstants.ServiceName,"D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)");RunSc("start",AppConstants.ServiceName);}
  static async Task<string> WaitForAdminApproval(string server){if(!Uri.TryCreate(server,UriKind.Absolute,out var baseUri)||baseUri.Scheme!="https"&&!baseUri.IsLoopback)throw new ArgumentException("Enrollment server must use HTTPS");using var rsa=RSA.Create(2048);var publicKey=rsa.ExportSubjectPublicKeyInfoPem();using var http=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(20)};var content=new StringContent(JsonSerializer.Serialize(new{deviceName=Environment.MachineName,publicKey}),Encoding.UTF8,"application/json");using var created=await http.PostAsync(new Uri(baseUri,"/api/agent/device-enrollments"),content);if(!created.IsSuccessStatusCode)throw new InvalidOperationException($"Could not request device approval (HTTP {(int)created.StatusCode})");using var createdJson=JsonDocument.Parse(await created.Content.ReadAsStringAsync());var id=createdJson.RootElement.GetProperty("request").GetProperty("id").GetString()??throw new InvalidDataException("Enrollment response is invalid");Console.Error.WriteLine($"Waiting for an administrator to approve {Environment.MachineName} in Dashboard > Devices");var deadline=DateTime.UtcNow.AddMinutes(15);while(DateTime.UtcNow<deadline){await Task.Delay(TimeSpan.FromSeconds(3));using var response=await http.GetAsync(new Uri(baseUri,$"/api/agent/device-enrollments?id={id}"));if(!response.IsSuccessStatusCode)continue;using var json=JsonDocument.Parse(await response.Content.ReadAsStringAsync());var request=json.RootElement.GetProperty("request");var status=request.GetProperty("status").GetString();if(status=="expired")break;if(status!="approved")continue;var encrypted=request.GetProperty("encrypted_token").GetString()??"";var token=Encoding.UTF8.GetString(rsa.Decrypt(Convert.FromBase64String(encrypted),RSAEncryptionPadding.OaepSHA256));await ValidateEnrollment(server,token);return token;}throw new TimeoutException("Device approval expired. Run setup again and approve the computer within 15 minutes");}
  static async Task ValidateEnrollment(string server,string token){if(!Uri.TryCreate(server,UriKind.Absolute,out var baseUri)||baseUri.Scheme!="https"&&!baseUri.IsLoopback)throw new ArgumentException("Enrollment server must use HTTPS");using var http=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(15)};using var request=new HttpRequestMessage(HttpMethod.Get,new Uri(baseUri,"/api/agent/device"));request.Headers.Add("X-Vorion-Device-Token",token);using var response=await http.SendAsync(request);if(!response.IsSuccessStatusCode)throw new UnauthorizedAccessException("Device enrollment token is unknown or revoked");}
  static string Value(string[] args,string key){var i=Array.IndexOf(args,key);if(i<0||i+1>=args.Length)throw new ArgumentException($"{key} is required");return args[i+1];}
  static string? OptionalValue(string[] args,string key){var i=Array.IndexOf(args,key);return i>=0&&i+1<args.Length?args[i+1]:null;}
  public static void RunSc(params string[] args){var info=new ProcessStartInfo("sc.exe"){UseShellExecute=false};foreach(var arg in args)info.ArgumentList.Add(arg);using var p=Process.Start(info)!;p.WaitForExit();if(p.ExitCode!=0 && !(args[0]=="stop"&&p.ExitCode==1062))throw new Win32Exception(p.ExitCode,$"sc.exe {args[0]} failed");}
}

static class InteractiveProcess {
  public static int GetActiveSessionId(){var console=unchecked((int)Native.WTSGetActiveConsoleSessionId());var active=new List<int>();if(Native.WTSEnumerateSessions(IntPtr.Zero,0,1,out var buffer,out var count)){try{var size=Marshal.SizeOf<Native.WTS_SESSION_INFO>();for(var i=0;i<count;i++){var info=Marshal.PtrToStructure<Native.WTS_SESSION_INFO>(IntPtr.Add(buffer,i*size));if(info.State==Native.WTS_CONNECTSTATE_CLASS.WTSActive)active.Add(info.SessionID);}}finally{Native.WTSFreeMemory(buffer);}}if(active.Contains(console))return console;return active.FirstOrDefault(-1);}
  public static bool IsSessionLocked(int sessionId){if(sessionId<0||!Native.WTSQuerySessionInformation(IntPtr.Zero,sessionId,25,out var buffer,out var bytes)||buffer==IntPtr.Zero)return true;try{return bytes<16||Marshal.ReadInt32(buffer,0)!=1||Marshal.ReadInt32(buffer,12)==0;}finally{Native.WTSFreeMemory(buffer);}}
  public static int Launch(string exe,string args,int sessionId){if(!Native.WTSQueryUserToken((uint)sessionId,out var token))throw new Win32Exception();IntPtr environment=IntPtr.Zero;try{if(!Native.CreateEnvironmentBlock(out environment,token,false))throw new Win32Exception();var si=new Native.STARTUPINFO{cb=Marshal.SizeOf<Native.STARTUPINFO>(),lpDesktop="winsta0\\default"};if(!Native.CreateProcessAsUser(token,exe,$"\"{exe}\" {args}",IntPtr.Zero,IntPtr.Zero,false,0x00000400,environment,Path.GetDirectoryName(exe),ref si,out var pi))throw new Win32Exception();Native.CloseHandle(pi.hThread);Native.CloseHandle(pi.hProcess);return pi.dwProcessId;}finally{if(environment!=IntPtr.Zero)Native.DestroyEnvironmentBlock(environment);Native.CloseHandle(token);}}
}
static class Native {
  public enum WTS_CONNECTSTATE_CLASS { WTSActive, WTSConnected, WTSConnectQuery, WTSShadow, WTSDisconnected, WTSIdle, WTSListen, WTSReset, WTSDown, WTSInit }
  [StructLayout(LayoutKind.Sequential)]public struct WTS_SESSION_INFO{public int SessionID;public IntPtr pWinStationName;public WTS_CONNECTSTATE_CLASS State;}
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct STARTUPINFO{public int cb;public string? lpReserved;public string? lpDesktop;public string? lpTitle;public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;public short wShowWindow,cbReserved2;public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;}
  [StructLayout(LayoutKind.Sequential)]public struct PROCESS_INFORMATION{public IntPtr hProcess,hThread;public int dwProcessId,dwThreadId;}
  [DllImport("kernel32.dll")]public static extern uint WTSGetActiveConsoleSessionId(); [DllImport("wtsapi32.dll",SetLastError=true)]public static extern bool WTSQueryUserToken(uint id,out IntPtr token);
  [DllImport("wtsapi32.dll",SetLastError=true)]public static extern bool WTSEnumerateSessions(IntPtr server,int reserved,int version,out IntPtr sessions,out int count); [DllImport("wtsapi32.dll")]public static extern void WTSFreeMemory(IntPtr memory); [DllImport("wtsapi32.dll",SetLastError=true)]public static extern bool WTSQuerySessionInformation(IntPtr server,int sessionId,int infoClass,out IntPtr buffer,out int bytesReturned);
  [DllImport("userenv.dll",SetLastError=true)]public static extern bool CreateEnvironmentBlock(out IntPtr environment,IntPtr token,bool inherit); [DllImport("userenv.dll",SetLastError=true)]public static extern bool DestroyEnvironmentBlock(IntPtr environment);
  [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)]public static extern bool CreateProcessAsUser(IntPtr token,string app,string command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string? cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll",SetLastError=true)]public static extern bool CloseHandle(IntPtr h); [DllImport("kernel32.dll",SetLastError=true)]public static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
}
