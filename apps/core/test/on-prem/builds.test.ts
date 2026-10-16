import { appIdSchema } from "@grasp-os/shared/ids";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { builderOwner } from "../../src/platform-sandbox.ts";
import { runInSession } from "../../src/sandbox-session.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import { buildOnSave } from "../../src/save-builds.ts";
import { buildScreens, buildServer } from "../../src/screens.ts";
import { server, workflowFiles } from "../workflow-apps.ts";

// The screen compiler on-prem: it runs on the sandbox host this project
// starts (src/platform-sandbox.ts), never in core's own process, whose
// Loader here throws if a build reaches for it. A type built to recurse
// holds TypeScript's checker for good: the supervisor ends it at its
// deadline, and core answers meanwhile.

/** A Loader core never reaches on-prem: compiling here would hold core. */
const noLoader: WorkerLoader = {
  get: () => {
    throw new Error("Core loaded the compiler itself.");
  },
  load: () => {
    throw new Error("Core loaded the compiler itself.");
  },
};

/** How long a build may take on the sandbox host here. */
const DEADLINE_MS = 4000;

/** How long core may take to answer another request meanwhile. */
const ANSWER_MS = 500;

/** Core's env as on-prem, its Loader one a build must never reach. */
const onPrem = { ...env, LOADER: noLoader };

/** A screen with this code before its component. */
const screen = (code: string): Record<string, string> => ({
  "screens/desk.tsx": `${code}
export default function Desk() {
  return <p>desk</p>;
}
`,
});

/**
 * Types each of which takes TypeScript's checker seconds to expand, a
 * union of 2^16 nested tuples, and none of which reuses another's work:
 * a few lines that hold the checker far past any deadline.
 */
const recursiveTypes = `type Split<T, N extends unknown[]> = N extends [unknown, ...infer R] ? Split<[T, 0], R> | Split<[T, 1], R> : T;
type Sixteen = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
${Array.from(
  { length: 40 },
  (_, index) =>
    `export const held${index}: Split<"${index}", Sixteen> = ${index};`
).join("\n")}`;

/** How long core takes to answer a request that builds nothing. */
const answerTime = async (): Promise<number> => {
  const started = Date.now();
  const response = await exports.default.fetch("https://core/health");
  await response.text();
  return Date.now() - started;
};

describe("the screen compiler on-prem", () => {
  it("builds an App's screens on the sandbox host, not in core", async () => {
    const built = await buildScreens(onPrem, screen(""), "app-test");

    expect({
      ok: built.ok,
      screen: built.ok && Object.keys(built.screens),
    }).toStrictEqual({ ok: true, screen: [expect.stringContaining("desk")] });
  });

  it("builds an App's server code on the sandbox host", async () => {
    const built = await buildServer(
      onPrem,
      {
        "app/server.ts": `import { DurableObject } from "cloudflare:workers";\n\nexport class App extends DurableObject {\n  book(): string {\n    return "booked";\n  }\n}\n`,
      },
      "app-test"
    );

    expect(built.ok).toBeTruthy();
  });

  it("says what fails to type-check, as it does on Cloudflare", async () => {
    const built = await buildScreens(
      onPrem,
      screen('export const count: number = "seven";'),
      "app-test"
    );

    expect(built.ok ? [] : built.diagnostics.map(({ rule }) => rule)).toContain(
      "TS2322"
    );
  });

  it("stops a screen whose types recurse without end at its deadline, and core answers meanwhile", async () => {
    const started = Date.now();
    const building = buildScreens(
      { ...onPrem, SANDBOX_DEADLINE_MS: String(DEADLINE_MS) },
      screen(recursiveTypes),
      "app-test"
    );
    // Asked while the checker spins on the sandbox host.
    await scheduler.wait(DEADLINE_MS / 2);
    const meanwhile = await answerTime();
    const built = await building;
    const took = Date.now() - started;

    expect(meanwhile).toBeLessThan(ANSWER_MS);
    expect(
      built.ok ? [] : built.diagnostics.map(({ message }) => message)
    ).toStrictEqual([
      expect.stringContaining("The compiler was stopped before it finished"),
    ]);
    // At its deadline, not at the 30 s a build may take otherwise.
    expect(took).toBeLessThan(DEADLINE_MS + 5000);
  });

  it("runs the compiler once for a screen it was stopped on for its own sake, however often it's viewed", async () => {
    // Every build kept: one per time the compiler ran to an end it keeps.
    let kept = 0;
    const counting = {
      ...onPrem,
      FILES: {
        get: env.FILES.get.bind(env.FILES),
        put: async (...args: Parameters<R2Bucket["put"]>) => {
          kept += 1;
          return await env.FILES.put(...args);
        },
      },
    };
    const files = screen(`${recursiveTypes}\n// viewed`);
    // Three views at once, then one more once they're done.
    const views = await Promise.all(
      [1, 2, 3].map(async () => await buildScreens(counting, files, "app-test"))
    );
    const started = Date.now();
    const later = await buildScreens(counting, files, "app-test");
    const tookLater = Date.now() - started;

    expect(
      [...views, later].map((built) =>
        built.ok ? "built" : built.diagnostics[0]?.message.slice(0, 44)
      )
    ).toStrictEqual(
      Array.from(
        { length: 4 },
        () => "The compiler was stopped before it finished:"
      )
    );
    expect(kept).toBe(1);
    // Read from the cache: the compiler didn't run again.
    expect(tookLater).toBeLessThan(1000);
  }, 120_000);

  it("reads the compiler's code from core's assets once, however many builds it runs", async () => {
    let read = 0;
    const counting = {
      ...onPrem,
      ASSETS: {
        fetch: async (...args: Parameters<Fetcher["fetch"]>) => {
          if (new Request(...args).url.endsWith("/compiler.js")) {
            read += 1;
          }
          return await env.ASSETS.fetch(...args);
        },
        connect: env.ASSETS.connect.bind(env.ASSETS),
      },
    };
    const first = await buildScreens(
      counting,
      screen("// first read"),
      "app-test"
    );
    const second = await buildScreens(
      counting,
      screen("// second read"),
      "app-test"
    );

    expect({ first: first.ok, second: second.ok, read }).toStrictEqual({
      first: true,
      second: true,
      read: 1,
    });
  });

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
      await buildScreens(onPrem, screen("// waits for a place"), "app-test");
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
      buildScreens(
        onPrem,
        screen(`// waits a moment ${crypto.randomUUID()}`),
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

  it("builds a fresh save's screens, server and workflows, its compiles waiting for the App's part of the builders' share", async () => {
    // Fresh, so nothing is read from the cache: three compiles at once,
    // where the App's part of the share is one place.
    const fresh = crypto.randomUUID();
    const saved = await buildOnSave(onPrem, {
      app: appIdSchema.parse("app-on-prem-save"),
      version: 1,
      files: {
        ...screen(`// ${fresh}`),
        "app/server.ts": `${server}\n// ${fresh}\n`,
        ...workflowFiles(
          "single",
          `  return await step.do("only", { description: "${fresh}" }, async () => "done");`
        ),
      },
    });

    expect({
      screens: saved.screens.status,
      server: saved.server.status,
      workflows: saved.workflows.status,
    }).toStrictEqual({ screens: "ok", server: "ok", workflows: "ok" });
  }, 90_000);

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
    const same = screen(`// the same ${crypto.randomUUID()}`);
    await Promise.allSettled([
      buildScreens(refused, same, "app-a"),
      buildScreens(refused, same, "app-b"),
    ]);

    expect({
      appAAskedAgain: asks.filter((whose) => whose === "app-a").length > 2,
      appBAskedItself: asks.includes("app-b"),
    }).toStrictEqual({ appAAskedAgain: true, appBAskedItself: true });
  }, 90_000);

  it("builds the same screen again once the sandbox stopped it at its deadline, as that stop isn't cached", async () => {
    const files = screen(`${recursiveTypes}\n// again`);
    const stopped = { ...onPrem, SANDBOX_DEADLINE_MS: "1500" };
    const first = await buildScreens(stopped, files, "app-test");
    const started = Date.now();
    const second = await buildScreens(stopped, files, "app-test");

    expect({ first: first.ok, second: second.ok }).toStrictEqual({
      first: false,
      second: false,
    });
    // Built again, to its deadline: not a failure read from the cache.
    expect(Date.now() - started).toBeGreaterThan(1000);
  });
});
