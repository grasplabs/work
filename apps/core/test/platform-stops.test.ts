import { isExpectedError } from "@grasp-os/shared/errors";
import { isolateBase } from "@grasp-os/shared/runtime";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  ExtractorUnavailableError,
  localExtractor,
} from "../src/files/extract.ts";
import { buildPages } from "../src/pages.ts";
import { SandboxUnavailableError } from "../src/sandboxed.ts";
import { sandboxStopping } from "./sandbox-stopping.ts";
import { unique } from "./sign-in.ts";

// How the release's platform code (the App compiler; the package
// builder's in packages.test.ts) is judged when the sandbox stops it (src/platform-sandbox.ts),
// from its threat model:
// - A stop the load caused (the shared machine's processes killed, waits
//   pushing it past its deadline) is kept as the input's own verdict: a
//   page pinned as "the compiler was stopped" until the next release, or
//   packages refused, that a free machine would have built.
// - A stop at a limit (CPU time, memory, an answer too large) kept as the
//   files' own failure, so they never build again until they change,
//   though the limit was reached only this once. A stop is never kept: the
//   next build tries again.
// - The same page is judged one way on Cloudflare (the runtime stops a
//   Loader isolate) and another on-prem (the supervisor's verdict).
// - Builds that find no place in the sandbox are reported as having maybe
//   run, so a caller can't safely try again.
// The sandbox host here is the test's own: it takes a session and stops
// its call as its supervisor would, keeping the verdict for core to ask.

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

/** A page no other build has. */
const freshPage = (): Record<string, string> => ({
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

// ${unique()}
function Desk() {
  return <p>desk</p>;
}
export const Route = createFileRoute("/")({ component: Desk });
`,
});

/** How each of two builds of the same page ended: built, or why not. */
const twoBuilds = async (buildEnv: Parameters<typeof buildPages>[0]) => {
  const files = freshPage();
  const ended = [];
  for (const _ of [1, 2]) {
    // One after the other: the second finds what the first kept, or not.
    // oxlint-disable-next-line no-await-in-loop
    const built = await buildPages(buildEnv, files, "app-test");
    ended.push(
      built.ok ? "built" : (built.diagnostics[0]?.message.slice(0, 44) ?? "")
    );
  }
  return ended;
};

const stoppedOnce = "The compiler was stopped before it finished:";

/** A compiler's `build` body that throws `message`. */
const throwing = (message: string): string =>
  `throw new Error(${JSON.stringify(message)});`;

/** An isolate whose compiler's builds (whole and incremental) run `body`. */
const compilerOf = (body: string): WorkerLoaderWorkerCode => ({
  ...isolateBase,
  mainModule: "compiler.js",
  modules: {
    "compiler.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async build() {
    const built = await (async () => { ${body} })();
    return { built };
  }
  async buildIncrementally() {
    return { built: await this.build(), fresh: { modules: {} }, metrics: {} };
  }
}`,
  },
});

/**
 * Cloudflare's Loader as the compiler sees it: its shared, warm isolate
 * (`get`) and a fresh one of a build's own (`load`), each running its
 * body, and counted. Plain workerd enforces no limits: a body that fails
 * as the runtime fails an isolate it stopped stands in for one.
 */
const compilers = (bodies: { shared: string; fresh: string }) => {
  const counts = { shared: 0, fresh: 0 };
  const loader: WorkerLoader = {
    get: () => {
      counts.shared += 1;
      return env.LOADER.get(`shared-${unique()}`, () =>
        compilerOf(bodies.shared)
      );
    },
    load: () => {
      counts.fresh += 1;
      return env.LOADER.load(compilerOf(bodies.fresh));
    },
  };
  return { loader, compiles: () => ({ ...counts }) };
};

/** Core's env on Cloudflare, with `loader` and `files` as its own. */
const onCloudflare = (
  loader: WorkerLoader,
  files: ReturnType<typeof countingFiles>["files"]
) => ({ ...env, LOADER: loader, RUNTIME_PROFILE: "cloudflare", FILES: files });

describe("a type check stopped in the shared checker", () => {
  it("is checked again in an isolate of its own, and only that answer counts, so another App's memory never fails it", async () => {
    // The release's shared checker, stopped at its memory, as another
    // App's check beside this one can leave it.
    const asked: string[] = [];
    const loader: WorkerLoader = {
      get: (name, code) => {
        if (name?.startsWith("check:") === true) {
          asked.push("shared");
          return env.LOADER.get(`stopped-${crypto.randomUUID()}`, () => ({
            ...isolateBase,
            mainModule: "checker.js",
            modules: {
              "checker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  check() { throw new Error("Worker exceeded memory limit."); }
}`,
            },
          }));
        }
        return env.LOADER.get(name, code);
      },
      load: (code) => {
        asked.push("own");
        return env.LOADER.load(code);
      },
    };
    const built = await buildPages(
      { ...env, LOADER: loader, RUNTIME_PROFILE: "cloudflare" },
      {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

// ${crypto.randomUUID()}\nexport const wrong: number = "x";\nfunction Desk() {\n  return <p>desk</p>;\n}\n
export const Route = createFileRoute("/")({ component: Desk });
`,
      },
      "app-test"
    );
    expect({
      asked,
      found: built.ok ? [] : built.diagnostics.map(({ rule }) => rule),
    }).toStrictEqual({ asked: ["shared", "own"], found: ["TS2322"] });
  });
});

describe("a page the sandbox stops the compiler on", () => {
  it("is reported, never kept, when it reached a limit, and compiled again at the next build", async () => {
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
        sessions: 2,
        kept: 0,
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

  it("is reported on Cloudflare once a fresh isolate of its own stopped it too, never kept", async () => {
    const { loader, compiles } = compilers({
      shared: throwing("Worker exceeded memory limit."),
      fresh: throwing("Worker exceeded CPU time limit."),
    });
    const { files, kept } = countingFiles();

    const ended = await twoBuilds(onCloudflare(loader, files));

    expect({ ended, compiles: compiles(), kept: kept() }).toStrictEqual({
      ended: [stoppedOnce, stoppedOnce],
      compiles: { shared: 2, fresh: 2 },
      kept: 0,
    });
  });

  it("is built in a fresh isolate on Cloudflare when the shared one was stopped, as another App's build beside it can do", async () => {
    const { loader, compiles } = compilers({
      shared: throwing("Worker exceeded memory limit."),
      fresh: "return { ok: true, modules: {}, pages: {}, css: '' };",
    });
    const { files, kept } = countingFiles();

    const ended = await twoBuilds(onCloudflare(loader, files));

    expect({ ended, compiles: compiles(), kept: kept() }).toStrictEqual({
      ended: ["built", "built"],
      compiles: { shared: 1, fresh: 1 },
      kept: 1,
    });
  });

  it("isn't taken on Cloudflare for stopped by a message that only names a limit", async () => {
    const { loader } = compilers({
      shared: throwing("Can't read src/exceeded memory limit.ts"),
      fresh: throwing("Never loaded: nothing stopped the shared one."),
    });
    const { files, kept } = countingFiles();

    await expect(
      buildPages(onCloudflare(loader, files), freshPage(), "app-test")
    ).rejects.toThrow("Can't read src/exceeded memory limit.ts");
    expect(kept()).toBe(0);
  });

  it("is refused as no place in the sandbox, before anything ran, while builds hold their share", async () => {
    const { host } = sandboxStopping("busy");
    const { files, kept } = countingFiles();
    let refused: unknown;
    try {
      await buildPages(
        { ...env, SANDBOX_HOST: host, FILES: files },
        freshPage(),
        "app-test"
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

/** How an extraction on a host that stops it as `verdict` ended. */
const extractionStopped = async (verdict: string) => {
  const { host } = sandboxStopping({ verdict });
  try {
    await localExtractor({ ...env, SANDBOX_HOST: host })({
      name: "policy.pdf",
      mediaType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.7"),
    });
  } catch (error) {
    if (error instanceof ExtractorUnavailableError) {
      return { unavailable: true, busy: error.busy };
    }
    return { code: isExpectedError(error) ? error.code : String(error) };
  }
  return "extracted";
};

describe("an upload the sandbox stops the extractor on", () => {
  it("fails for good when it stopped the extractor itself", async () => {
    await expect(extractionStopped("memory")).resolves.toMatchObject({
      code: "upload.too_complex",
    });
  });

  it("is tried again when a crash or the deadline cut the extractor off", async () => {
    for (const verdict of ["crashed", "deadline"]) {
      // oxlint-disable-next-line no-await-in-loop -- one verdict at a time
      await expect(extractionStopped(verdict)).resolves.toStrictEqual({
        unavailable: true,
        busy: false,
      });
    }
  });
});
