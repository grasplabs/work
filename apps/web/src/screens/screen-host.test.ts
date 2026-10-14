import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { callFunction } from "./screen-host.ts";

// The page relaying a screen's function call to core: whatever comes back
// that isn't core's JSON reaches the screen as a coded error, never as
// what the response held.

const outcome = async (call: Promise<unknown>): Promise<unknown> => {
  try {
    return { answered: await call };
  } catch (error) {
    const code: unknown =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    return { code };
  }
};

describe("a screen's function call through the page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers core's JSON, and turns anything else into a coded error", async () => {
    const responses = [
      Response.json({ result: { ok: true, value: 1 } }),
      Response.json(
        { code: "screen.unreviewed", message: "Not approved." },
        { status: 403 }
      ),
      new Response("<html>Bad gateway</html>", { status: 502 }),
      new Response("<html>a proxy's page</html>", { status: 200 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => await Promise.resolve(responses.shift()))
    );
    const results = [];
    for (let call = 0; call < 4; call += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one response after another
      results.push(await outcome(callFunction("app", "lease", "{}")));
    }
    expect(results).toStrictEqual([
      { answered: { result: { ok: true, value: 1 } } },
      { code: "screen.unreviewed" },
      { code: "internal.unexpected" },
      { code: "internal.unexpected" },
    ]);
  });

  it("turns a request that never reached core into a coded error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await Promise.resolve();
        throw new TypeError("Failed to fetch");
      })
    );
    await expect(
      outcome(callFunction("app", "lease", "{}"))
    ).resolves.toStrictEqual({ code: "internal.unexpected" });
  });
});
