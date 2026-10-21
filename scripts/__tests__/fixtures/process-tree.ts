import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installShutdownHandlers, ProcessSupervisor } from "../../lib/processes.js";

const mode = process.argv[2];
const marker = process.env.H3M_TEST_MARKER!;
function record(event: string, extra = {}) { appendFileSync(marker, `${JSON.stringify({ event, pid: process.pid, ...extra })}\n`); }
const args = (childMode: string) => ["--import", "tsx", fileURLToPath(import.meta.url), childMode];

if (mode === "supervisor") {
  const supervisor = new ProcessSupervisor(process.cwd(), Number(process.env.H3M_TEST_GRACE_MS ?? 800));
  const abort = new AbortController();
  const dispose = installShutdownHandlers(abort, supervisor);
  const child = supervisor.launch(process.execPath, args("leader"));
  record("owned", { group: child.process.pid });
  try { await new Promise<void>(resolve => abort.signal.addEventListener("abort", () => resolve(), { once: true })); }
  finally { await supervisor.stop(); dispose(); }
} else if (mode === "leader") {
  spawn(process.execPath, args("worker"), { stdio: "inherit" });
  process.on("SIGTERM", () => { record("leader-stopping"); process.exit(0); });
  setInterval(() => undefined, 10_000);
} else if (mode === "worker") {
  process.on("SIGTERM", () => {
    record("worker-stopping");
    if (process.env.H3M_TEST_STUBBORN !== "1") {
      setTimeout(() => { record("worker-finished"); process.exit(0); }, 200);
    }
  });
  setInterval(() => undefined, 10_000);
  record("ready");
}
