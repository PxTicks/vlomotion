import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findExecutable, npmCommand } from "../lib/processes.js";

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

describe("launcher commands", () => {
  async function pathFixture(files: string[], test: (root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "h3m-path-"));
    try {
      for (const file of files) {
        await mkdir(join(root, file, ".."), { recursive: true });
        await writeFile(join(root, file), ""); await chmod(join(root, file), 0o755);
      }
      await test(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  // A POSIX PATH splits on ":", which would also split a Windows drive letter.
  it.skipIf(process.platform === "win32")("finds executables on a POSIX PATH", () => pathFixture(["bin/uv"], async root => {
    expect(await findExecutable("uv", `${join(root, "missing")}:${join(root, "bin")}`, "linux")).toBe(join(root, "bin", "uv"));
  }));
  it("requires .exe on a Windows PATH", () => pathFixture(["posix/uv", "windows/uv.exe", "windows/comfy-api-proxy.cmd"], async root => {
    const [posix, windows] = [join(root, "posix"), join(root, "windows")];
    expect(await findExecutable("uv", `${posix};${windows}`, "win32")).toBe(join(windows, "uv.exe"));
    expect(await findExecutable("comfy-api-proxy", windows, "win32")).toBeUndefined();
  }));
  it("runs npm's CLI script through Node when npm provides it", () => {
    expect(npmCommand(["run", "dev:app"], "/usr/lib/node_modules/npm/bin/npm-cli.js")).toEqual([process.execPath, ["/usr/lib/node_modules/npm/bin/npm-cli.js", "run", "dev:app"]]);
    expect(npmCommand(["run", "dev:app"], "")).toEqual(["npm", ["run", "dev:app"]]);
  });
});
