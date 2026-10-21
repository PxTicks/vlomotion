import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAppPorts } from "../../vite.config";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Vite ports in standalone dev:app", () => {
  it("reads API and web ports from the same .env format as the server", () => {
    const root = mkdtempSync(join(tmpdir(), "h3m-env-")); roots.push(root);
    const file = join(root, ".env");
    writeFileSync(file, 'PORT="8800"\nWEB_PORT=5185\n');
    expect(readAppPorts({}, file)).toEqual({ api: 8800, web: 5185 });
    expect(readAppPorts({ PORT: "8801", WEB_PORT: "5186" }, file)).toEqual({ api: 8801, web: 5186 });
  });
  it("uses defaults without an .env file", () => {
    const root = mkdtempSync(join(tmpdir(), "h3m-env-")); roots.push(root);
    expect(readAppPorts({}, join(root, ".env"))).toEqual({ api: 8790, web: 5180 });
  });
});
