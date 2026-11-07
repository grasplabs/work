import { npmRegistryOrigin } from "@grasp-os/shared/dependencies";
import { appIdSchema } from "@grasp-os/shared/ids";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { runBuilder } from "../../src/packages/build.ts";
import { buildPages } from "../../src/pages.ts";
import { builderOwner, platformRunner } from "../../src/platform-sandbox.ts";
import { sandboxCpuHeader } from "../../src/sandbox-headers.ts";
import { runInSession } from "../../src/sandbox-session.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import { draftLintBuild } from "../../src/save-builds.ts";
import { probeModule } from "../isolate-probe.ts";

// The App compiler on-prem: it runs on the sandbox host this project
// starts (src/platform-sandbox.ts), never in core's own process, whose
// Loader here throws if a build reaches for it. A type built to recurse
// holds TypeScript's checker for good: the supervisor ends it at its
// deadline, and core answers meanwhile. Gone with App workflows: a save
// compiling its pages and its workflows at once, in the App's part of
// the builders' share; a build waiting for its part is "builds once a
// place held a moment … comes free" below.

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

/** A page with this code before its component. */
const page = (code: string): Record<string, string> => ({
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

${code}
function Desk() {
  return <p>desk</p>;
}
export const Route = createFileRoute("/")({ component: Desk });
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

describe("a build task's CPU on-prem", () => {
  it("gives the compiler, the type checker and the package builder each one build task's CPU, spec 18.1's 60 s, on the sandbox host", async () => {
    const host = env.SANDBOX_HOST;
    if (host === undefined) {
      throw new Error("The on-prem project binds SANDBOX_HOST.");
    }
    // What core asks of the sandbox host for each call it starts.
    const asked: string[] = [];
    const recording: Fetcher = {
      ...host,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const cpu = new Request(input, init).headers.get(sandboxCpuHeader);
        if (cpu !== null) {
          asked.push(cpu);
        }
        return await host.fetch(input, init);
      },
      connect: host.connect.bind(host),
    };
    const watched = { ...onPrem, SANDBOX_HOST: recording };
    const built = await buildPages(
      watched,
      page(`// fresh ${crypto.randomUUID()}`),
      "app-test"
    );
    const compiled = asked.length;
    // A lock with nothing to build: the builder answers why, after the
    // call this asks the sandbox host to start.
    const answer = await runBuilder(
      watched,
      "app:cpu-test",
      {
        lockfileVersion: 2,
        registry: npmRegistryOrigin,
        requested: {},
        direct: {},
        entries: ["missing"],
        packages: {},
      },
      []
    );
    expect({
      built: built.ok,
      answered: typeof answer === "object" && answer !== null,
      compiler: asked.slice(0, compiled),
      builder: asked.slice(compiled),
    }).toStrictEqual({
      built: true,
      answered: true,
      // The compiler's call, then the type checker's.
      compiler: [
        String(platformLimits.compilerTaskCpuMs),
        String(platformLimits.compilerTaskCpuMs),
      ],
      builder: [String(platformLimits.compilerTaskCpuMs)],
    });
  });
});

describe("the App compiler on-prem", () => {
  it("builds an App's pages on the sandbox host, not in core", async () => {
    const built = await buildPages(onPrem, page(""), "app-test");

    expect({
      ok: built.ok,
      entry: built.ok && built.entry,
    }).toStrictEqual({ ok: true, entry: "app~src~routeTree.gen.js" });
  });

  it("says what fails to type-check, as it does on Cloudflare", async () => {
    const built = await buildPages(
      onPrem,
      page('export const count: number = "seven";'),
      "app-test"
    );

    expect(built.ok ? [] : built.diagnostics.map(({ rule }) => rule)).toContain(
      "TS2322"
    );
  });

  it("stops a page whose types recurse without end at its deadline, and core answers meanwhile", async () => {
    const started = Date.now();
    const building = buildPages(
      { ...onPrem, SANDBOX_DEADLINE_MS: String(DEADLINE_MS) },
      page(recursiveTypes),
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

  it("keeps no build of a page the compiler was stopped on at a limit, so the next view tries again", async () => {
    // Every whole build kept. The compiler's transforms are kept besides
    // (build-cache.ts): it ends, and the type checker is what the types
    // stop.
    let kept = 0;
    const counting = {
      ...onPrem,
      FILES: {
        get: env.FILES.get.bind(env.FILES),
        put: async (...args: Parameters<R2Bucket["put"]>) => {
          // A whole build says whether it is `ok`; a transform doesn't.
          if (typeof args[1] === "string" && args[1].startsWith('{"ok":')) {
            kept += 1;
          }
          return await env.FILES.put(...args);
        },
      },
    };
    const files = page(`${recursiveTypes}\n// viewed`);
    // Three views at once, then one more once they're done.
    const views = await Promise.all(
      [1, 2, 3].map(async () => await buildPages(counting, files, "app-test"))
    );
    const later = await buildPages(counting, files, "app-test");

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
    expect(kept).toBe(0);
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
    const first = await buildPages(counting, page("// first read"), "app-test");
    const second = await buildPages(
      counting,
      page("// second read"),
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

  it("builds the same page again once the sandbox stopped it at its deadline, as that stop isn't cached", async () => {
    const files = page(`${recursiveTypes}\n// again`);
    const stopped = { ...onPrem, SANDBOX_DEADLINE_MS: "1500" };
    const first = await buildPages(stopped, files, "app-test");
    const started = Date.now();
    const second = await buildPages(stopped, files, "app-test");

    expect({ first: first.ok, second: second.ok }).toStrictEqual({
      first: false,
      second: false,
    });
    // Built again, to its deadline: not a failure read from the cache.
    expect(Date.now() - started).toBeGreaterThan(1000);
  });
});

/**
 * Core's env as on-prem, its assets answering `probeModule` in place of
 * the program at `program` (`/compiler.js`, `/package-builder.js`): what
 * runs there is the probe, on the sandbox host, as that program runs.
 */
const probing = (program: string) => ({
  ...onPrem,
  ASSETS: {
    fetch: async (...args: Parameters<Fetcher["fetch"]>) =>
      new Request(...args).url.endsWith(program)
        ? new Response(probeModule, {
            headers: { "content-type": "text/javascript" },
          })
        : await env.ASSETS.fetch(...args),
    connect: env.ASSETS.connect.bind(env.ASSETS),
  },
});

describe("Ultracite's lint on-prem", () => {
  it("fails a draft's lint as one that couldn't run, at its first deadline, never splitting it nor blaming a file", async () => {
    // A lint that never ends, as one the shared machine starved would: its
    // deadline is the load's, not the files' (`PlatformBoundError.own`),
    // so splitting the call would only wait out a deadline for each half.
    const spinning = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  lint() {
    for (;;) {}
  }
}
`;
    const { SANDBOX_HOST: host } = env;
    if (host === undefined) {
      throw new Error("The on-prem project binds SANDBOX_HOST.");
    }
    let sessions = 0;
    const stopped = {
      ...onPrem,
      SANDBOX_DEADLINE_MS: "1500",
      SANDBOX_HOST: {
        fetch: async (...args: Parameters<Fetcher["fetch"]>) => {
          if (new Request(...args).url === "http://sandbox/session") {
            sessions += 1;
          }
          return await host.fetch(...args);
        },
        connect: host.connect.bind(host),
      },
      ASSETS: {
        fetch: async (...args: Parameters<Fetcher["fetch"]>) =>
          new Request(...args).url.endsWith("/ultracite.js")
            ? new Response(spinning, {
                headers: { "content-type": "text/javascript" },
              })
            : await env.ASSETS.fetch(...args),
        connect: env.ASSETS.connect.bind(env.ASSETS),
      },
    };

    const linted = await draftLintBuild(stopped, {
      app: appIdSchema.parse(crypto.randomUUID()),
      version: 0,
      files: Object.fromEntries(
        Array.from({ length: 4 }, (_, at) => [
          `src/components/same-${at}.ts`,
          `export const same${at} = (a: number, b: number) => a == b;\n// ${crypto.randomUUID()}\n`,
        ])
      ),
    });

    expect({
      status: linted.status,
      diagnostics: linted.diagnostics,
      sessions,
    }).toStrictEqual({ status: "error", diagnostics: [], sessions: 1 });
  }, 60_000);
});

describe("the platform's programs on the sandbox host", () => {
  it.each([
    ["App compiler", "compiler", "/compiler.js"],
    ["type checker", "type-checker", "/checker.js"],
    ["Ultracite's lint", "ultracite", "/ultracite.js"],
    ["package builder", "package-builder", "/package-builder.js"],
  ] as const)(
    "run the %s with no bindings and no network",
    async (_case, program, path) => {
      const report = await platformRunner(probing(path), "app-test").run(
        program,
        "report",
        []
      );
      expect(report).toStrictEqual({
        env: [],
        imported: [],
        fetch: "refused",
        connect: "refused",
      });
    },
    60_000
  );
});
