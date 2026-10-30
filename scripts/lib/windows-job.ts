import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";

// Node's own Windows child job only holds direct children, so a grandchild outlives an npm or cmd.exe parent.
// A job without breakaway also holds every later descendant of the launcher, whichever parent has exited.
const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class H3mJob {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, int code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  static IntPtr job;

  public static void Own(int pid) {
    // Ctrl+C reaches every process in the console; this helper must outlive it to clean up.
    SetConsoleCtrlHandler(IntPtr.Zero, true);
    job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Win32Exception();
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, with LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
    int size = IntPtr.Size == 8 ? 144 : 112;
    IntPtr limits = Marshal.AllocHGlobal(size);
    try {
      for (int i = 0; i < size; i++) Marshal.WriteByte(limits, i, 0);
      Marshal.WriteInt32(limits, 16, 0x2000);
      if (!SetInformationJobObject(job, 9, limits, size)) throw new Win32Exception();
    } finally { Marshal.FreeHGlobal(limits); }
    IntPtr process = OpenProcess(0x0101, false, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if (process == IntPtr.Zero) throw new Win32Exception();
    try { if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(); }
    finally { CloseHandle(process); }
  }

  public static int StopAllExcept(int pid) {
    int size = 8 + IntPtr.Size * 4096; // JOBOBJECT_BASIC_PROCESS_ID_LIST
    IntPtr list = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, 3, list, size, IntPtr.Zero)) throw new Win32Exception();
      int stopped = 0;
      for (int i = 0, count = Marshal.ReadInt32(list, 4); i < count; i++) {
        int id = (int)Marshal.ReadIntPtr(list, 8 + i * IntPtr.Size).ToInt64();
        if (id == pid) continue;
        IntPtr process = OpenProcess(0x0001, false, id); // PROCESS_TERMINATE
        if (process == IntPtr.Zero) continue;
        if (TerminateProcess(process, 1)) stopped++;
        CloseHandle(process);
      }
      return stopped;
    } finally { Marshal.FreeHGlobal(list); }
  }
}
'@
  [H3mJob]::Own(LAUNCHER_PID)
  [Console]::Out.WriteLine('ready')
} catch {
  [Console]::Out.WriteLine("error $($_.Exception.Message)")
  exit 1
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq 'stop') { [Console]::Out.WriteLine("stopped $([H3mJob]::StopAllExcept(LAUNCHER_PID))") }
}
`;

/**
 * Puts the launcher in a Windows job object, so stop() reaches descendants whose parent has already exited.
 * The helper holds the only job handle: if the launcher dies, Node ends the helper and the job ends what remains.
 */
export class WindowsJob {
  /** Resolves to the helper's error, or undefined once the launcher is in the job. */
  readonly ready: Promise<string | undefined>;
  private readonly helper: ChildProcess;
  private readonly replies: AsyncIterator<string>;

  constructor(pid = process.pid) {
    const script = HELPER.replaceAll("LAUNCHER_PID", String(pid));
    this.helper = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.helper.once("error", () => { /* The closed output ends ready with an error. */ });
    // Closing the helper would end the launcher with its job, so it lives until the launcher exits.
    this.helper.unref();
    (this.helper.stdin as Socket).unref();
    (this.helper.stdout as Socket).unref();
    this.replies = createInterface({ input: this.helper.stdout! })[Symbol.asyncIterator]();
    this.ready = this.request().then(reply => reply === "ready" ? undefined : reply?.replace(/^error /, "") ?? "PowerShell did not start");
  }

  /** Ends every process in the job except the launcher. */
  async stop(): Promise<boolean> {
    return (await this.request("stop"))?.startsWith("stopped ") ?? false;
  }

  private async request(command?: string): Promise<string | undefined> {
    const output = this.helper.stdout as Socket;
    output.ref();
    try {
      if (command) this.helper.stdin!.write(`${command}\n`);
      const reply = await this.replies.next();
      return reply.done ? undefined : reply.value;
    } catch { return undefined; }
    finally { output.unref(); }
  }
}
