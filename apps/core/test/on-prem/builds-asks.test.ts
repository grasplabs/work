import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { buildPages } from "../../src/pages.ts";
import { builderOwner } from "../../src/platform-sandbox.ts";
import { runInSession } from "../../src/sandbox-session.ts";
import { onPrem, page } from "./builds-harness.ts";

// The App compiler on-prem: it runs on the sandbox host this project
// starts (src/platform-sandbox.ts), never in core's own process, whose
// Loader here throws if a build reaches for it. A type built to recurse
// holds TypeScript's checker for good: the supervisor ends it at its
// deadline, and core answers meanwhile. Gone with App workflows: a save
// compiling its pages and its workflows at once, in the App's part of
// the builders' share; a build waiting for its part is "builds once a
// place held a moment … comes free" below.

describe("the App compiler on-prem", () => {
  it("builds once a place held a moment, past one ask's wait, comes free: it asks again", async () => {
    const host = env.SANDBOX_HOST;
    if (host === undefined) {
      throw new Error("The on-prem project binds SANDBOX_HOST.");
    }
    // The builders' one place, held past one ask's wait (3 s).
    const holding = runInSession(host, {
      mainModule: "m.js",
      modules: {
        "m.js":
          'import { WorkerEntrypoint } from "cloudflare:workers";\nexport class E extends WorkerEntrypoint { async go() { for (;;) {} } }',
      },
      entrypoint: "E",
      method: "go",
      args: [],
      cpuMs: 20_000,
      wallMs: 6000,
      owner: builderOwner,
    });
    await scheduler.wait(500);
    // Settled together: the holder ends while the build waits.
    const [held, built] = await Promise.allSettled([
      holding,
      buildPages(
        onPrem,
        page(`// waits a moment ${crypto.randomUUID()}`),
        "app-test"
      ),
    ]);

    expect({
      heldToItsDeadline:
        held.status === "rejected" &&
        String(held.reason).includes("ran past its time"),
      built: built.status === "fulfilled" && built.value.ok,
    }).toStrictEqual({ heldToItsDeadline: true, built: true });
  }, 60_000);

  it("asks again while refused, and builds another App's same files in its own part", async () => {
    // A sandbox that refuses every session as busy, a moment after each
    // ask, and says whose each ask was.
    const asks: string[] = [];
    const refusing: Fetcher = {
      connect: () => {
        throw new Error("The sandbox takes no sockets.");
      },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname !== "/session") {
          return Response.json({});
        }
        const whose = request.headers.get("x-grasp-sandbox-sub-owner") ?? "";
        asks.push(whose);
        await scheduler.wait(200);
        return new Response("busy", { status: 429 });
      },
    };
    const refused = { ...onPrem, SANDBOX_HOST: refusing };
    const same = page(`// the same ${crypto.randomUUID()}`);
    await Promise.allSettled([
      buildPages(refused, same, "app-a"),
      buildPages(refused, same, "app-b"),
    ]);

    expect({
      appAAskedAgain: asks.filter((whose) => whose === "app-a").length > 2,
      appBAskedItself: asks.includes("app-b"),
    }).toStrictEqual({ appAAskedAgain: true, appBAskedItself: true });
  }, 90_000);
});
