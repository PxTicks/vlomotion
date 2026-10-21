import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../api";

afterEach(() => vi.unstubAllGlobals());

describe("API error responses", () => {
  it.each([
    [502, ""],
    [503, "<html>Bad gateway</html>"],
    [500, '{"error":'],
  ])("reports HTTP status %i when the body is not valid JSON", async (status, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
    await expect(apiRequest("/health")).rejects.toThrow(`Request failed (${status}).`);
  });
  it("preserves a structured application error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Session expired." }, { status: 401 })));
    await expect(apiRequest("/health")).rejects.toThrow("Session expired.");
  });
  it("reports malformed success responses separately", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json")));
    await expect(apiRequest("/health")).rejects.toThrow("invalid JSON response (200)");
  });
});
