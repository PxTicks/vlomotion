import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLauncherPlatform } from "../lib/processes.js";

interface Event { event: string; pid: number; group?: number }
interface Fixture { child: ChildProcess; root: string; marker: string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }
const fixtures: Fixture[] = [];

async function events(fixture: Fixture): Promise<Event[]> {
  try { return (await readFile(fixture.marker, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Event); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function fixture(stubborn = false): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "h3m-process-"));
  const marker = join(root, "events.jsonl");
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/process-tree.ts", import.meta.url)), "supervisor"], {
    stdio: "ignore", env: { ...process.env, H3M_TEST_MARKER: marker, H3M_TEST_STUBBORN: stubborn ? "1" : "0" },
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const result = { root, marker, child, exited }; fixtures.push(result);
  await vi.waitFor(async () => expect((await events(result)).some(event => event.event === "ready")).toBe(true), { timeout: 10_000 });
  return result;
}

async function workerHasStopped(fixture: Fixture) {
  const pid = (await events(fixture)).find(event => event.event === "ready")!.pid;
  await vi.waitFor(async () => {
    try {
      process.kill(pid, 0);
      // Linux container init may leave a killed orphan as a zombie; it is no longer running.
      if (process.platform === "linux") expect(await readFile(`/proc/${pid}/status`, "utf8")).toMatch(/State:\s+Z/);
      else throw new Error("Worker is still running");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "ENOENT") throw error;
    }
  }, { timeout: 3000 });
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    const group = (await events(item)).find(event => event.event === "owned")?.group;
    if (group) { try { process.kill(-group, "SIGKILL"); } catch { /* Already stopped. */ } }
    if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill("SIGKILL");
    await item.exited;
    await rm(item.root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("owned process group cleanup", () => {
  it("lets descendants finish after the group leader exits", async () => {
    const item = await fixture();
    item.child.kill("SIGTERM");
    expect(await item.exited).toEqual({ code: 0, signal: null });
    expect((await events(item)).map(event => event.event)).toContain("worker-finished");
    await workerHasStopped(item);
  }, 15_000);
  it("force-stops children on a second Ctrl+C instead of terminating the supervisor", async () => {
    const item = await fixture(true);
    item.child.kill("SIGINT");
    await vi.waitFor(async () => expect((await events(item)).some(event => event.event === "worker-stopping")).toBe(true));
    item.child.kill("SIGINT");
    expect(await item.exited).toEqual({ code: 0, signal: null });
    await workerHasStopped(item);
  }, 15_000);
  it("cleans up children when the terminal sends SIGHUP", async () => {
    const item = await fixture(true);
    item.child.kill("SIGHUP");
    expect(await item.exited).toEqual({ code: 0, signal: null });
    await workerHasStopped(item);
  }, 15_000);
});

it("explicitly rejects a native Windows launcher while allowing WSL/Linux/macOS", () => {
  expect(() => assertLauncherPlatform("win32")).toThrow("Run the dev launcher in WSL");
  expect(() => assertLauncherPlatform("linux")).not.toThrow();
  expect(() => assertLauncherPlatform("darwin")).not.toThrow();
});
