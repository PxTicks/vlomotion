import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WindowsJob } from "./windows-job.js";

export interface ProcessExit { code: number | null; signal: NodeJS.Signals | null; error?: Error }
export interface OwnedProcess { process: ChildProcess; exited: Promise<ProcessExit>; result?: ProcessExit }

/** Finds an executable on PATH. Windows only accepts .exe, since .cmd shims need a shell to run. */
export async function findExecutable(name: string, path = process.env.PATH ?? "", platform = process.platform): Promise<string | undefined> {
  const file = platform === "win32" ? `${name}.exe` : name;
  for (const directory of path.split(platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    const candidate = join(directory, file);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

/** Runs npm's own CLI script through Node, which avoids npm.cmd's shell requirement on Windows. */
export function npmCommand(args: string[], execPath = process.env.npm_execpath): [string, string[]] {
  return execPath && /\.[cm]?js$/.test(execPath) ? [process.execPath, [execPath, ...args]] : ["npm", args];
}

/**
 * Owns POSIX process groups, including descendants whose npm/uv parent has exited.
 * Windows has no process groups; a job object holding the launcher owns its descendants instead.
 */
export class ProcessSupervisor {
  private readonly owned: OwnedProcess[] = [];
  private shutdown?: Promise<void>;
  private forced = false;
  private readonly windows = process.platform === "win32";
  private job?: WindowsJob;
  /** Launch only after this resolves; Windows descendants started earlier are outside the job. */
  readonly ready: Promise<void>;

  constructor(private readonly cwd: string, private readonly graceMs = 3000) {
    const job = this.windows ? new WindowsJob() : undefined;
    this.ready = (async () => {
      const error = await job?.ready;
      if (error) console.warn(`[h3-motion] Could not create a Windows job object (${error}). Shutdown can miss processes whose parent has exited.`);
      else this.job = job;
    })();
  }

  launch(command: string, args: string[], env = process.env): OwnedProcess {
    if (this.shutdown) throw new Error("The launcher is shutting down.");
    // A detached Windows child opens its own console window instead of sharing this one.
    const child = spawn(command, args, { cwd: this.cwd, env, stdio: "inherit", detached: !this.windows });
    const entry: OwnedProcess = { process: child, exited: Promise.resolve({ code: null, signal: null }) };
    entry.exited = new Promise(resolve => {
      child.once("error", error => { entry.result = { code: 1, signal: null, error }; resolve(entry.result); });
      child.once("exit", (code, signal) => { entry.result = { code, signal }; resolve(entry.result); });
    });
    this.owned.push(entry);
    return entry;
  }

  private signal(entry: OwnedProcess, signal: NodeJS.Signals | 0): boolean {
    const pid = entry.process.pid;
    if (!pid) return false;
    try { process.kill(this.windows ? pid : -pid, signal); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  forceStop(): void {
    this.forced = true;
    // On Windows, stop() ends everything as soon as its grace loop sees the flag.
    if (!this.windows) for (const entry of [...this.owned].reverse()) this.signal(entry, "SIGKILL");
  }

  stop(): Promise<void> {
    this.shutdown ??= this.stopGroups();
    return this.shutdown;
  }

  private async stopGroups(): Promise<void> {
    // Windows console programs have no SIGTERM; Ctrl+C has already reached children sharing this console.
    if (!this.windows) for (const entry of [...this.owned].reverse()) this.signal(entry, "SIGTERM");
    const deadline = Date.now() + this.graceMs;
    // A group leader can exit before its descendants finish their shutdown handlers.
    while (!this.forced && Date.now() < deadline && this.owned.some(entry => this.signal(entry, 0))) {
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    if (this.windows) await this.stopWindows();
    else for (const entry of [...this.owned].reverse()) {
      if (this.signal(entry, 0)) this.signal(entry, "SIGKILL");
    }
    await Promise.all(this.owned.map(entry => entry.exited));
  }

  private async stopWindows(): Promise<void> {
    if (await this.job?.stop()) return;
    // Without the job, taskkill can still end each tree whose root is running.
    for (const entry of this.owned) {
      if (this.signal(entry, 0)) spawnSync("taskkill", ["/PID", String(entry.process.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
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
