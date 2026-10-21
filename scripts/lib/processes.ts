import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface ProcessExit { code: number | null; signal: NodeJS.Signals | null; error?: Error }
export interface OwnedProcess { process: ChildProcess; exited: Promise<ProcessExit>; result?: ProcessExit }

export function assertLauncherPlatform(platform = process.platform): void {
  if (platform === "win32") throw new Error("Run the dev launcher in WSL, Linux or macOS. Native Windows launchers are not supported; ComfyUI itself can run on Windows.");
}

/** Owns POSIX process groups, including descendants whose npm/uv parent has exited. */
export class ProcessSupervisor {
  private readonly owned: OwnedProcess[] = [];
  private shutdown?: Promise<void>;
  private forced = false;

  constructor(private readonly cwd: string, private readonly graceMs = 3000) {
    assertLauncherPlatform();
  }

  launch(command: string, args: string[], env = process.env): OwnedProcess {
    if (this.shutdown) throw new Error("The launcher is shutting down.");
    const child = spawn(command, args, { cwd: this.cwd, env, stdio: "inherit", detached: true });
    const entry: OwnedProcess = { process: child, exited: Promise.resolve({ code: null, signal: null }) };
    entry.exited = new Promise(resolve => {
      child.once("error", error => { entry.result = { code: 1, signal: null, error }; resolve(entry.result); });
      child.once("exit", (code, signal) => { entry.result = { code, signal }; resolve(entry.result); });
    });
    this.owned.push(entry);
    return entry;
  }

  private signal(entry: OwnedProcess, signal: NodeJS.Signals | 0): boolean {
    if (!entry.process.pid) return false;
    try { process.kill(-entry.process.pid, signal); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  forceStop(): void {
    this.forced = true;
    for (const entry of [...this.owned].reverse()) this.signal(entry, "SIGKILL");
  }

  stop(): Promise<void> {
    this.shutdown ??= this.stopGroups();
    return this.shutdown;
  }

  private async stopGroups(): Promise<void> {
    for (const entry of [...this.owned].reverse()) this.signal(entry, "SIGTERM");
    const deadline = Date.now() + this.graceMs;
    // A group leader can exit before its descendants finish their shutdown handlers.
    while (!this.forced && Date.now() < deadline && this.owned.some(entry => this.signal(entry, 0))) {
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    for (const entry of [...this.owned].reverse()) {
      if (this.signal(entry, 0)) this.signal(entry, "SIGKILL");
    }
    await Promise.all(this.owned.map(entry => entry.exited));
  }
}

/** Keep all handlers installed throughout shutdown; a repeated signal escalates. */
export function installShutdownHandlers(abort: AbortController, supervisor: ProcessSupervisor): () => void {
  const handler = () => {
    if (abort.signal.aborted) supervisor.forceStop();
    else {
      abort.abort();
      void supervisor.stop();
    }
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, handler);
  return () => { for (const signal of signals) process.off(signal, handler); };
}
