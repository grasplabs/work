import type { Role } from "@grasp-os/shared/roles";
import { isolateBase } from "@grasp-os/shared/runtime";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { resolveDependencies } from "../src/packages/resolve.ts";
import {
  sandboxCallIdHeader,
  sandboxCpuHeader,
} from "../src/sandbox-headers.ts";
import { SandboxUnavailableError } from "../src/sandboxed.ts";
import { buildScreens } from "../src/screens.ts";
import { mockIdp } from "./idp.ts";
import { failure, intentFor, named, plain, publish } from "./npm.ts";
import { signedInApi, unique } from "./sign-in.ts";

// How the release's platform code (the screen compiler, the package
// builder) is judged when the sandbox stops it (src/platform-sandbox.ts),
// from its threat model:
// - A stop the load caused (the shared machine's processes killed, waits
//   pushing it past its deadline) is kept as the input's own verdict: a
//   screen pinned as "the compiler was stopped" until the next release, or
//   packages refused, that a free machine would have built.
// - A stop the input reaches whatever the load (its CPU time, its memory,
//   an answer too large) isn't kept, and every view of a screen that holds
//   the type checker runs the compiler again, at its CPU bound each time.
// - The same screen is judged one way on Cloudflare (the runtime stops a
//   Loader isolate) and another on-prem (the supervisor's verdict).
// - Builds that find no place in the sandbox are reported as having maybe
//   run, so a caller can't safely try again.
// The sandbox host here is the test's own: it takes a session and stops
// its call as its supervisor would, keeping the verdict for core to ask.

const idp = mockIdp();

/** How the test's sandbox host stops each call: a verdict, or no place. */
type Stop = { verdict: string } | "busy";

/** A sandbox host that stops every call as `stop` says. Counts its sessions. */
const sandboxStopping = (stop: Stop) => {
  let sessions = 0;
  const verdicts = new Map<string, string>();
  const host: Fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/verdict/")) {
        const verdict = verdicts.get(pathname.slice("/verdict/".length));
        return await Promise.resolve(
          Response.json(
            verdict === undefined
              ? { verdict: null, state: "ending" }
              : { verdict, message: `Stopped (${verdict}).` }
          )
        );
      }
      if (pathname !== "/session") {
        return await Promise.resolve(new Response("{}"));
      }
      if (stop === "busy") {
        return await Promise.resolve(new Response("{}", { status: 429 }));
      }
      sessions += 1;
      const id = request.headers.get(sandboxCallIdHeader) ?? "";
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      // Its process stopped once the call arrived, as the supervisor would.
      server.addEventListener(
        "message",
        () => {
          verdicts.set(id, stop.verdict);
          server.close(1011, "The process was stopped.");
        },
        { once: true }
      );
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: {
          [sandboxCpuHeader]: request.headers.get(sandboxCpuHeader) ?? "",
        },
      });
    },
    connect: () => {
      throw new Error("Not a socket host");
    },
  };
  return { host, sessions: () => sessions };
};

/** Core's builds cache, counting what it keeps. */
const countingFiles = () => {
  let kept = 0;
  const files = {
    get: env.FILES.get.bind(env.FILES),
    put: async (...args: Parameters<R2Bucket["put"]>) => {
      kept += 1;
      return await env.FILES.put(...args);
    },
  };
  return { files, kept: () => kept };
};

/** A screen no other build has. */
const freshScreen = (): Record<string, string> => ({
  "screens/desk.tsx": `// ${unique()}
export default function Desk() {
  return <p>desk</p>;
}
`,
});

/** How each of two builds of the same screen ended: built, or why not. */
const twoBuilds = async (buildEnv: Parameters<typeof buildScreens>[0]) => {
  const files = freshScreen();
  const ended = [];
  for (const _ of [1, 2]) {
    // One after the other: the second finds what the first kept, or not.
    // oxlint-disable-next-line no-await-in-loop
    const built = await buildScreens(buildEnv, files);
    ended.push(
      built.ok ? "built" : (built.diagnostics[0]?.message.slice(0, 44) ?? "")
    );
  }
  return ended;
};

const stoppedOnce = "The compiler was stopped before it finished:";

describe("a screen the sandbox stops the compiler on", () => {
  it("is kept as failed when the screen stopped it itself, and never compiled again", async () => {
    for (const verdict of ["cpu", "memory", "refused"]) {
      const { host, sessions } = sandboxStopping({ verdict });
      const { files, kept } = countingFiles();

      // oxlint-disable-next-line no-await-in-loop -- one verdict at a time
      const ended = await twoBuilds({
        ...env,
        SANDBOX_HOST: host,
        FILES: files,
      });

      expect({
        verdict,
        ended,
        sessions: sessions(),
        kept: kept(),
      }).toStrictEqual({
        verdict,
        ended: [stoppedOnce, stoppedOnce],
        sessions: 1,
        kept: 1,
      });
    }
  });

  it("is compiled again when its compile was cut off by a crash or the deadline, which the load can cause", async () => {
    for (const verdict of ["crashed", "deadline"]) {
      const { host, sessions } = sandboxStopping({ verdict });
      const { files, kept } = countingFiles();

      // oxlint-disable-next-line no-await-in-loop -- one verdict at a time
      const ended = await twoBuilds({
        ...env,
        SANDBOX_HOST: host,
        FILES: files,
      });

      expect({
        verdict,
        ended,
        sessions: sessions(),
        kept: kept(),
      }).toStrictEqual({
        verdict,
        ended: [stoppedOnce, stoppedOnce],
        sessions: 2,
        kept: 0,
      });
    }
  });

  it("is kept as failed on Cloudflare too, where the runtime stops the compiler's isolate at its CPU limit", async () => {
    let compiles = 0;
    // Plain workerd enforces no CPU limit: an isolate that fails each build
    // as the runtime fails one it stopped stands in for it.
    const overCpu: WorkerLoader = {
      get: () => {
        compiles += 1;
        return env.LOADER.get(`over-cpu-${unique()}`, () => ({
          ...isolateBase,
          mainModule: "compiler.js",
          modules: {
            "compiler.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async build() { throw new Error("Worker exceeded CPU time limit."); }
}`,
          },
        }));
      },
      load: () => {
        throw new Error("The compiler is kept warm, never loaded per build.");
      },
    };
    const { files, kept } = countingFiles();

    const ended = await twoBuilds({
      ...env,
      LOADER: overCpu,
      RUNTIME_PROFILE: "cloudflare",
      FILES: files,
    });

    expect({ ended, compiles, kept: kept() }).toStrictEqual({
      ended: [stoppedOnce, stoppedOnce],
      compiles: 1,
      kept: 1,
    });
  });

  it("is refused as no place in the sandbox, before anything ran, while builds hold their share", async () => {
    const { host } = sandboxStopping("busy");
    const { files, kept } = countingFiles();
    let refused: unknown;
    try {
      await buildScreens(
        { ...env, SANDBOX_HOST: host, FILES: files },
        freshScreen()
      );
    } catch (error) {
      refused = error;
    }

    expect({
      unavailable: refused instanceof SandboxUnavailableError,
      status: refused instanceof SandboxUnavailableError && refused.status,
      started: refused instanceof SandboxUnavailableError && refused.started,
      kept: kept(),
    }).toStrictEqual({
      unavailable: true,
      status: 429,
      started: false,
      kept: 0,
    });
  });
});

/** A builder with a new App of theirs, and the package it asks for. */
const builderAsking = async (role: Role = "builder") => {
  const builder = await signedInApi(idp, role);
  const { id: app } = await builder.api.apps.create({
    name: `App ${unique()}`,
  });
  const name = named("dates");
  await publish(plain(name, "1.0.0"));
  return {
    identity: await builder.api.whoami(),
    intent: intentFor(app, { [name]: "^1.0.0" }),
  };
};

describe("packages the sandbox stops the builder on", () => {
  it("are refused when they stopped it themselves", async () => {
    const { host } = sandboxStopping({ verdict: "memory" });
    const { identity, intent } = await builderAsking();

    const outcome = await failure(
      resolveDependencies({ ...env, SANDBOX_HOST: host }, identity, intent)
    );

    expect(outcome.code).toBe("package.refused");
  });

  it("aren't refused when a crash cut the builder off: the sandbox was unavailable", async () => {
    const { host } = sandboxStopping({ verdict: "crashed" });
    const { identity, intent } = await builderAsking();

    await expect(
      resolveDependencies({ ...env, SANDBOX_HOST: host }, identity, intent)
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });
});
