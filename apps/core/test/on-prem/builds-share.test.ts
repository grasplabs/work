import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { buildPages } from "../../src/pages.ts";
import { builderOwner } from "../../src/platform-sandbox.ts";
import { runInSession } from "../../src/sandbox-session.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import { onPrem, page } from "./builds-harness.ts";

// The App compiler on-prem: it runs on the sandbox host this project
// starts (src/platform-sandbox.ts), never in core's own process, whose
// Loader here throws if a build reaches for it. A type built to recurse
// holds TypeScript's checker for good: the supervisor ends it at its
// deadline, and core answers meanwhile. Gone with App workflows: a save
// compiling its pages and its workflows at once, in the App's part of
// the builders' share; a build waiting for its part is "builds once a
// place held a moment … comes free" in builds-asks.test.ts.

describe("the App compiler on-prem", () => {
  it("refuses a build as no place in the sandbox, before it started, while the builders' share is held past the build wait", async () => {
    // Two processes here, so the builders' share is one: a call of theirs
    // that spins holds it to its deadline, past the build's asks for a
    // place, which go on for the build wait (15 s).
    const host = env.SANDBOX_HOST;
    if (host === undefined) {
      throw new Error("The on-prem project binds SANDBOX_HOST.");
    }
    const holding = runInSession(host, {
      mainModule: "m.js",
      modules: {
        "m.js":
          'import { WorkerEntrypoint } from "cloudflare:workers";\nexport class E extends WorkerEntrypoint { async go() { for (;;) {} } }',
      },
      entrypoint: "E",
      method: "go",
      args: [],
      cpuMs: 30_000,
      wallMs: 25_000,
      owner: builderOwner,
    });
    await scheduler.wait(500);
    const asked = Date.now();
    let refused: unknown;
    try {
      await buildPages(onPrem, page("// waits for a place"), "app-test");
    } catch (error) {
      refused = error;
    }
    const askedFor = Date.now() - asked;
    await expect(holding).rejects.toThrow("ran past its time");

    expect({
      unavailable: refused instanceof SandboxUnavailableError,
      status: refused instanceof SandboxUnavailableError && refused.status,
      started: refused instanceof SandboxUnavailableError && refused.started,
      // Asked again for most of the build wait (15 s), no ask past it.
      askedForTheWait: askedFor > 8000 && askedFor < 15_000,
    }).toStrictEqual({
      unavailable: true,
      status: 429,
      started: false,
      askedForTheWait: true,
    });
  }, 60_000);
});
